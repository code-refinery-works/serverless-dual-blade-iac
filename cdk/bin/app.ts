#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { ServerlessApiStack } from "../lib/stack";

const app = new cdk.App();

new ServerlessApiStack(app, "ServerlessApiStack", {
  projectName: app.node.tryGetContext("projectName") ?? "serverless-api",
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region:  process.env.CDK_DEFAULT_REGION ?? "ap-northeast-1",
  },
});