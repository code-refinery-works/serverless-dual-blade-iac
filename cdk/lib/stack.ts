import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as logs from "aws-cdk-lib/aws-logs";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as cw_actions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as iam from "aws-cdk-lib/aws-iam";

interface Props extends cdk.StackProps { projectName: string; }

export class ServerlessApiStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const { projectName } = props;

    // Resolve Terraform-managed resources via SSM
    const tableName   = ssm.StringParameter.valueFromLookup(this, `/${projectName}/dynamo/table-name`);
    const lambdaRoleArn = ssm.StringParameter.valueFromLookup(this, `/${projectName}/lambda/role-arn`);
    const snsAlarmArn = ssm.StringParameter.valueFromLookup(this, `/${projectName}/sns/alarm-arn`);

    const lambdaRole = iam.Role.fromRoleArn(this, "LambdaRole", lambdaRoleArn);
    const alarmTopic = sns.Topic.fromTopicArn(this, "AlarmTopic", snsAlarmArn);

    // Lambda Function
    const handler = new lambda.Function(this, "ApiHandler", {
      functionName:  `${projectName}-handler`,
      runtime:       lambda.Runtime.NODEJS_20_X,
      architecture:  lambda.Architecture.ARM_64,
      handler:       "index.handler",
      code:          lambda.Code.fromInline(`
        const { DynamoDBClient, PutItemCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
        const client = new DynamoDBClient({});
        exports.handler = async (event) => {
          const table = process.env.TABLE_NAME;
          if (event.requestContext?.http?.method === "GET") {
            const id = event.pathParameters?.id ?? "default";
            const res = await client.send(new GetItemCommand({ TableName: table, Key: { pk: { S: id }, sk: { S: "item" } } }));
            return { statusCode: 200, body: JSON.stringify(res.Item ?? {}) };
          }
          const body = JSON.parse(event.body ?? "{}");
          await client.send(new PutItemCommand({ TableName: table, Item: { pk: { S: body.id }, sk: { S: "item" }, data: { S: JSON.stringify(body) } } }));
          return { statusCode: 201, body: JSON.stringify({ id: body.id }) };
        };`),
      role:          lambdaRole,
      environment:   { TABLE_NAME: tableName },
      timeout:       cdk.Duration.seconds(29),
      memorySize:    512,
      tracing:       lambda.Tracing.ACTIVE,
      logRetention:  logs.RetentionDays.ONE_MONTH,
    });

    // HTTP API Gateway
    const accessLog = new logs.LogGroup(this, "ApiAccessLog", {
      logGroupName:  `/aws/apigateway/${projectName}`,
      retention:     logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const httpApi = new apigwv2.HttpApi(this, "HttpApi", {
      apiName:            `${projectName}-api`,
      corsPreflight:      { allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST], allowOrigins: ["*"] },
      defaultAuthorizer:  undefined,
      createDefaultStage: false,
    });

    const stage = new apigwv2.HttpStage(this, "ProdStage", {
      httpApi,
      stageName:   "prod",
      autoDeploy:  true,
      accessLogSettings: { destinationArn: accessLog.logGroupArn },
    });

    const integration = new integrations.HttpLambdaIntegration("LambdaInteg", handler);
    httpApi.addRoutes({ path: "/items",     methods: [apigwv2.HttpMethod.POST], integration });
    httpApi.addRoutes({ path: "/items/{id}", methods: [apigwv2.HttpMethod.GET],  integration });

    // CloudWatch Alarms
    const mk = (id: string, ns: string, metric: string, dims: Record<string,string>, th: number) =>
      new cloudwatch.Alarm(this, id, {
        metric: new cloudwatch.Metric({ namespace: ns, metricName: metric, dimensionsMap: dims, period: cdk.Duration.minutes(1), statistic: "Sum" }),
        threshold: th, evaluationPeriods: 1, comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      });

    const alarms = [
      mk("Alarm5XX",       "AWS/ApiGateway", "5XXError",  { ApiId: httpApi.apiId }, 5),
      mk("AlarmLambdaErr", "AWS/Lambda",     "Errors",    { FunctionName: handler.functionName }, 3),
      mk("AlarmThrottle",  "AWS/Lambda",     "Throttles", { FunctionName: handler.functionName }, 1),
    ];
    alarms.forEach(a => a.addAlarmAction(new cw_actions.SnsAction(alarmTopic)));

    // Outputs
    new cdk.CfnOutput(this, "ApiEndpoint", { value: `${httpApi.apiEndpoint}/prod` });
    new cdk.CfnOutput(this, "FunctionName", { value: handler.functionName });
  }
}