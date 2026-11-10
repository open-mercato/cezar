/** The only host-wide tracker option is the credential-free offline demo. */
export function trackerConfiguration(env: NodeJS.ProcessEnv = process.env) {
  return { dryRun: env.CEZ_DRY_RUN === '1' };
}
