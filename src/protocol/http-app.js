'use strict';

function createHttpApp({ express, cors }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  app.use(express.json({ verify(req, _res, buffer) { req.principalRawBody = Buffer.from(buffer); } }));
  return app;
}

function registerHealthAndAuth(app, { pkg, createAuthMiddleware, isAllowedPeer, EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest, principalAuthentication }) {
  // Health check – no auth required
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: pkg.version });
  });

  if (principalAuthentication) app.get('/api/auth/challenge', (_req, res) => res.set('Cache-Control', 'no-store').json(principalAuthentication.challengeDocument()));

  // Authentication Middleware
  app.use(createAuthMiddleware({ isAllowedPeer, expectedToken: EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest, principalAuthentication }));
}

module.exports = { createHttpApp, registerHealthAndAuth };
