'use strict';

function createHttpApp({ express, cors }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  app.use(express.json());
  return app;
}

function registerHealthAndAuth(app, { pkg, createAuthMiddleware, isAllowedPeer, EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest }) {
  // Health check – no auth required
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', version: pkg.version });
  });

  // Authentication Middleware
  app.use(createAuthMiddleware({ isAllowedPeer, expectedToken: EXPECTED_TOKEN, verifyJwt, isForbiddenOrigin, authorizeSessionRequest }));
}

module.exports = { createHttpApp, registerHealthAndAuth };
