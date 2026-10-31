'use strict';

function createHttpApp({ express, cors }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  app.use(express.json({ verify(req, _res, buffer) { req.principalRawBody = Buffer.from(buffer); } }));
  return app;
}

function registerHealthAndAuth(app, { pkg, createAuthMiddleware, isAllowedPeer, EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest, principalAuthentication,
  supervisionAuthentication = null }) {
  // Health check – no auth required
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: pkg.version });
  });

  if (principalAuthentication) app.get('/api/auth/challenge', (_req, res) => res.set('Cache-Control', 'no-store').json(principalAuthentication.challengeDocument()));
  // Task 1215 combined mode: the operator-supervision verifier's challenge (never both: the daemon
  // refuses TELEPTY_SUPERVISION_TRUST_FILE together with strict mode).
  else if (supervisionAuthentication) app.get('/api/auth/challenge', (_req, res) => res.set('Cache-Control', 'no-store').json(supervisionAuthentication.challengeDocument()));

  // Authentication Middleware
  app.use(createAuthMiddleware({ isAllowedPeer, expectedToken: EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest, principalAuthentication,
    supervisionAuthentication: principalAuthentication ? null : supervisionAuthentication }));
}

module.exports = { createHttpApp, registerHealthAndAuth };
