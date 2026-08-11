#!/usr/bin/env node
import process from "node:process";
import { main } from "./cli.js";
import { safeError } from "./redaction.js";

export async function runAction(environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const config = environment.INPUT_CONFIG?.trim() || "ctxprof.config.json";
  const pricing = environment.INPUT_PRICING?.trim();
  const args = ["check", "--config", config, "--github"];
  if (pricing) args.push("--pricing", pricing);
  return main(args);
}

runAction().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    const message = safeError(error);
    process.stdout.write(`::error title=Ctxprof action failed::${escapeWorkflow(message)}\n`);
    process.stderr.write(`ctxprof: ${message}\n`);
    process.exitCode = 1;
  },
);

function escapeWorkflow(value: string): string {
  return value.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
