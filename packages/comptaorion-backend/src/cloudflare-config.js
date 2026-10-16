export function configurationProblems(env) {
  const problems = [];
  for (const key of ['DATABASE_URL', 'JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if (!env[key]) problems.push(`${key} manquant`);
  }
  for (const key of ['JWT_SECRET', 'JWT_REFRESH_SECRET']) {
    if (env[key] && env[key].length < 32) problems.push(`${key} trop court (32 caractères minimum)`);
  }
  if (env.JWT_SECRET && env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
    problems.push('Les deux clés JWT doivent être différentes');
  }
  if (env.DATABASE_URL) {
    try {
      const url = new URL(env.DATABASE_URL);
      if (!['postgres:', 'postgresql:'].includes(url.protocol)) problems.push('DATABASE_URL doit désigner PostgreSQL');
    } catch {
      problems.push('DATABASE_URL invalide');
    }
  }
  return problems;
}
