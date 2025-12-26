/**
 * Authentication module for MCP server.
 *
 * Supports three modes:
 * - none: No authentication
 * - bearer: Static bearer token validation
 * - oauth: OAuth 2.0 with token introspection or userinfo validation
 *
 * Uses openid-client library for OIDC discovery and token validation.
 */
import { type RequestHandler } from 'express';
import * as client from 'openid-client';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { type OAuthMetadata } from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  MCP_BEARER_TOKEN,
  MCP_OAUTH_CLIENT_ID,
  MCP_OAUTH_CLIENT_SECRET,
  MCP_OAUTH_DISCOVERY_RETRIES,
  MCP_OAUTH_DISCOVERY_RETRY_DELAY_MS,
  MCP_OAUTH_INTERNAL_ISSUER_URL,
  MCP_OAUTH_PUBLIC_ISSUER_URL,
  MCP_AUTH_MODE,
  type AuthMode,
} from './config.js';

export interface AuthContext {
  mode: AuthMode;
  middleware: RequestHandler | null;
  oauthMetadata?: OAuthMetadata;
  validationMethod?: 'introspection' | 'userinfo';
}

export interface AuthOptions {
  enableOauth?: boolean;
  enableBearer?: boolean;
  port?: number;
}

interface TokenVerifierResult {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt?: number;
}

interface TokenVerifier {
  verifyAccessToken: (token: string) => Promise<TokenVerifierResult>;
}

/**
 * Determines the auth mode based on CLI flags and env var fallback.
 * CLI flags take precedence over MCP_AUTH_MODE env var.
 */
export const resolveAuthMode = (options: AuthOptions): AuthMode => {
  if (options.enableOauth) {
    return 'oauth';
  }
  if (options.enableBearer) {
    return 'bearer';
  }
  return MCP_AUTH_MODE;
};

const sleep = async (ms: number): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/**
 * Discovers OIDC configuration with retry logic for slow-starting auth servers.
 */
const discoverWithRetry = async (
  issuerUrl: string,
  clientId: string,
  clientSecret?: string
): Promise<client.Configuration> => {
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= MCP_OAUTH_DISCOVERY_RETRIES; attempt++) {
    try {
      // openid-client v6 API: discovery(server, clientId, metadata?, clientAuthentication?)
      // If clientSecret is provided, pass it as metadata (shorthand)
      const config = await client.discovery(
        new URL(issuerUrl),
        clientId,
        clientSecret, // When string, this is shorthand for client_secret
        clientSecret ? client.ClientSecretPost(clientSecret) : undefined
      );
      return config;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      console.error(`OIDC discovery attempt ${attempt}/${MCP_OAUTH_DISCOVERY_RETRIES} failed: ${lastError.message}`);

      if (attempt < MCP_OAUTH_DISCOVERY_RETRIES) {
        await sleep(MCP_OAUTH_DISCOVERY_RETRY_DELAY_MS);
      }
    }
  }

  throw new Error(`Unable to discover OIDC issuer at ${issuerUrl}: ${lastError?.message}`);
};

/**
 * Converts openid-client ServerMetadata to MCP SDK OAuthMetadata format.
 */
const toOAuthMetadata = (metadata: client.ServerMetadata, publicIssuer?: string): OAuthMetadata => {
  const issuer = publicIssuer ?? metadata.issuer;

  // Remap URLs to public issuer if provided
  const remap = (url: string | undefined): string | undefined => {
    if (!url || !publicIssuer) return url;
    try {
      const original = new URL(url);
      const pub = new URL(publicIssuer);
      return new URL(original.pathname + original.search, pub).href;
    } catch {
      return url;
    }
  };

  return {
    issuer,
    authorization_endpoint: remap(metadata.authorization_endpoint) ?? '',
    token_endpoint: remap(metadata.token_endpoint) ?? '',
    registration_endpoint: remap(metadata.registration_endpoint),
    scopes_supported: metadata.scopes_supported as string[] | undefined,
    response_types_supported: metadata.response_types_supported as string[],
    response_modes_supported: metadata.response_modes_supported as string[] | undefined,
    grant_types_supported: metadata.grant_types_supported as string[] | undefined,
    token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported as string[] | undefined,
    revocation_endpoint: remap(metadata.revocation_endpoint),
    revocation_endpoint_auth_methods_supported: metadata.revocation_endpoint_auth_methods_supported as
      | string[]
      | undefined,
    introspection_endpoint: remap(metadata.introspection_endpoint),
    introspection_endpoint_auth_methods_supported: metadata.introspection_endpoint_auth_methods_supported as
      | string[]
      | undefined,
    code_challenge_methods_supported: metadata.code_challenge_methods_supported as string[] | undefined,
    userinfo_endpoint: remap(metadata.userinfo_endpoint),
    jwks_uri: remap(metadata.jwks_uri),
  };
};

const buildBearerAuthContext = (): AuthContext => {
  const token = MCP_BEARER_TOKEN;
  if (token === undefined || token === '') {
    throw new Error('MCP_BEARER_TOKEN (or BEARER_TOKEN) is required when auth mode is bearer.');
  }

  const middleware = requireBearerAuth({
    verifier: {
      verifyAccessToken: async (accessToken: string) => {
        if (accessToken !== token) {
          throw new InvalidTokenError('Invalid token');
        }
        return {
          token: accessToken,
          clientId: 'local-user',
          scopes: ['mcp:tools'],
          expiresAt: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
        };
      },
    },
    requiredScopes: [],
  });

  return { mode: 'bearer', middleware };
};

/**
 * Creates a token verifier using openid-client.
 * Uses introspection if client credentials are provided, otherwise userinfo.
 */
const buildOidcTokenVerifier = (config: client.Configuration, useIntrospection: boolean): TokenVerifier => {
  return {
    verifyAccessToken: async (token: string): Promise<TokenVerifierResult> => {
      console.error(`[DEBUG] Verifying token (method: ${useIntrospection ? 'introspection' : 'userinfo'})`);
      console.error(`[DEBUG] Token prefix: ${token.substring(0, 20)}...`);
      try {
        if (useIntrospection) {
          // Token introspection (requires client credentials)
          const result = await client.tokenIntrospection(config, token);

          if (!result.active) {
            console.error('Token introspection returned inactive token');
            throw new InvalidTokenError('Token is not active');
          }

          return {
            token,
            clientId: (result.client_id as string) ?? (result.sub as string) ?? 'unknown',
            scopes: typeof result.scope === 'string' ? result.scope.split(' ') : [],
            expiresAt: result.exp as number | undefined,
          };
        } else {
          // Userinfo validation (works with opaque tokens like Google's)
          // Use skipSubjectCheck since we don't have a prior subject to verify
          console.error(`[DEBUG] Calling userinfo endpoint...`);
          const userinfo = await client.fetchUserInfo(config, token, client.skipSubjectCheck);
          console.error(`[DEBUG] Userinfo response: sub=${userinfo.sub}, email=${userinfo.email}`);

          const result = {
            token,
            clientId: userinfo.sub ?? 'unknown',
            scopes: [] as string[],
            // Set expiration to 1 hour from now (userinfo doesn't provide expiry)
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
          };
          console.error(`[DEBUG] Returning verifier result: ${JSON.stringify(result)}`);
          return result;
        }
      } catch (error) {
        console.error(`[DEBUG] Token validation error:`, error);
        if (error instanceof InvalidTokenError) {
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        console.error(`[DEBUG] Token validation failed: ${message}`);

        // Provide user-friendly error messages
        if (message.includes('401') || message.includes('unauthorized')) {
          throw new InvalidTokenError('Token rejected by authorization server');
        }
        if (message.includes('invalid_token')) {
          throw new InvalidTokenError('Invalid or expired token');
        }

        throw new InvalidTokenError('Token validation failed');
      }
    },
  };
};

const buildOAuthAuthContext = async (mcpPublicUrl: URL): Promise<AuthContext> => {
  const internalIssuerString = MCP_OAUTH_INTERNAL_ISSUER_URL;
  if (!internalIssuerString) {
    throw new Error('MCP_OAUTH_ISSUER_URL is required when auth mode is oauth.');
  }

  const clientId = MCP_OAUTH_CLIENT_ID ?? 'mcp-server';
  const clientSecret = MCP_OAUTH_CLIENT_SECRET;

  // Discover OIDC configuration
  console.error(`Discovering OIDC issuer: ${internalIssuerString}`);
  const config = await discoverWithRetry(internalIssuerString, clientId, clientSecret);
  console.error(`OIDC issuer discovered: ${config.serverMetadata().issuer}`);

  const serverMetadata = config.serverMetadata();

  // Determine validation method based on available credentials and endpoints
  const hasClientCredentials = !!(MCP_OAUTH_CLIENT_ID && MCP_OAUTH_CLIENT_SECRET);
  const hasIntrospectionEndpoint = !!serverMetadata.introspection_endpoint;
  const hasUserinfoEndpoint = !!serverMetadata.userinfo_endpoint;

  // Prefer introspection if we have credentials and endpoint, otherwise use userinfo
  const useIntrospection = hasClientCredentials && hasIntrospectionEndpoint;
  const validationMethod = useIntrospection ? 'introspection' : 'userinfo';

  if (!useIntrospection && !hasUserinfoEndpoint) {
    throw new Error(
      'OAuth configuration error: No userinfo endpoint available and no client credentials for introspection. ' +
        'Either provide MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET, or use an issuer with a userinfo endpoint.'
    );
  }

  console.error(`OAuth validation method: ${validationMethod}`);
  if (useIntrospection) {
    console.error(`Introspection endpoint: ${serverMetadata.introspection_endpoint}`);
  } else {
    console.error(`Userinfo endpoint: ${serverMetadata.userinfo_endpoint}`);
  }

  // Build token verifier using openid-client
  const verifier = buildOidcTokenVerifier(config, useIntrospection);

  const middleware = requireBearerAuth({
    verifier,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpPublicUrl),
  });

  // Convert to MCP SDK metadata format
  const oauthMetadata = toOAuthMetadata(serverMetadata, MCP_OAUTH_PUBLIC_ISSUER_URL);

  return { mode: 'oauth', middleware, oauthMetadata, validationMethod };
};

/**
 * Builds the authentication context based on CLI options and environment variables.
 * CLI flags take precedence over MCP_AUTH_MODE env var.
 */
export const buildAuthContext = async (options: AuthOptions = {}): Promise<AuthContext> => {
  const mode = resolveAuthMode(options);
  const port = options.port ?? 3000;
  const mcpPublicUrlString = process.env.MCP_PUBLIC_URL ?? `http://localhost:${port}/mcp`;
  const mcpPublicUrl = new URL(mcpPublicUrlString);

  switch (mode) {
    case 'none':
      console.error('MCP authentication disabled (auth mode: none)');
      return { mode, middleware: null };

    case 'bearer':
      return buildBearerAuthContext();

    case 'oauth':
      return buildOAuthAuthContext(mcpPublicUrl);

    default:
      console.error(`Unknown auth mode: ${mode}, defaulting to none`);
      return { mode: 'none', middleware: null };
  }
};
