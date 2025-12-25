# OAuth 2.0 Configuration Guide

This guide covers OAuth 2.0 authentication setup for the Actual MCP server, including provider-specific configurations for Google, Azure AD, Keycloak, Auth0, and Okta.

## Overview

The MCP server uses [openid-client](https://github.com/panva/openid-client) for OIDC discovery and token validation, supporting two validation methods:

| Method | Description | When to Use |
|--------|-------------|-------------|
| **Token Introspection** | Server-side validation via OAuth introspection endpoint (RFC 7662) | Keycloak, Auth0, Okta, or any provider with introspection support |
| **Userinfo Validation** | Validates tokens by calling the userinfo endpoint | Google or providers that use opaque tokens |

### Automatic Detection

The server automatically selects the appropriate validation method:

1. **Introspection** if client credentials (`MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`) are provided and an introspection endpoint is available
2. **Userinfo** if no credentials are provided (works with opaque tokens like Google's)

## Environment Variables Reference

### Required for All OAuth Configurations

| Variable | Description |
|----------|-------------|
| `MCP_OAUTH_ISSUER_URL` | OAuth issuer URL (OpenID Connect discovery base) |

### For Token Introspection (Optional)

| Variable | Description |
|----------|-------------|
| `MCP_OAUTH_CLIENT_ID` | Client ID for introspection requests |
| `MCP_OAUTH_CLIENT_SECRET` | Client secret for introspection requests |

### Advanced Settings

| Variable | Default | Description |
|----------|---------|-------------|
| `MCP_OAUTH_INTERNAL_ISSUER_URL` | - | Issuer URL for internal network (in case you are using Docker/reverse proxy) |
| `MCP_OAUTH_PUBLIC_ISSUER_URL` | - | Issuer URL exposed to clients (should be set if you are using the internal issuer url, so clients can connect directly)|
| `MCP_PUBLIC_URL` | - | Public URL of the MCP server |
| `MCP_OAUTH_DISCOVERY_RETRIES` | 30 | Retry attempts for metadata discovery (useful if you start keycloak and the mcp server at the same time, and keycloak isn't ready right away) |
| `MCP_OAUTH_DISCOVERY_RETRY_DELAY_MS` | 2000 | Delay between discovery retries |

---

## Provider-Specific Configurations

### Google OAuth

Google OAuth is fully supported using **userinfo validation**. Google issues opaque access tokens (not JWTs), so the server validates them by calling Google's userinfo endpoint.

**Environment Configuration:**

```bash
export MCP_OAUTH_ISSUER_URL="https://accounts.google.com"

node build/index.js --sse --enable-oauth
```

**Notes:**
- No client credentials are needed for token validation (userinfo is a public endpoint)
- The MCP client (e.g., Claude) will need its own Google OAuth credentials to complete the OAuth flow
- Token validation confirms the token is valid and retrieves the user's identity

---

### Azure AD / Microsoft Entra ID

Azure AD supports userinfo validation. Configure as follows:

**Setup Steps:**

1. Register an application in [Azure Portal](https://portal.azure.com/)
2. Navigate to App registrations → New registration
3. Configure API permissions (add `openid` and `profile` scopes)
4. Note your Directory (tenant) ID

**Environment Configuration:**

```bash
# For single-tenant apps
export MCP_OAUTH_ISSUER_URL="https://login.microsoftonline.com/{tenant-id}/v2.0"

# For multi-tenant apps
export MCP_OAUTH_ISSUER_URL="https://login.microsoftonline.com/common/v2.0"
```

**Notes:**
- Replace `{tenant-id}` with your Azure AD tenant ID
- Tokens are validated via the userinfo endpoint
- For multi-tenant apps, use `/common/` in the issuer URL

---

### Keycloak

Keycloak is best used with **token introspection**, which provides robust server-side validation.

**Setup Steps:**

1. Create a realm in Keycloak Admin Console
2. Create a client with "Client authentication" enabled (confidential client)
3. Note the client ID and secret from the Credentials tab

**Environment Configuration:**

```bash
export MCP_OAUTH_ISSUER_URL="https://keycloak.example.com/realms/YOUR_REALM"
export MCP_OAUTH_CLIENT_ID="mcp-server"
export MCP_OAUTH_CLIENT_SECRET="your-client-secret"
```

**Without Client Credentials:**

If you don't provide client credentials, userinfo validation will be used instead:

```bash
export MCP_OAUTH_ISSUER_URL="https://keycloak.example.com/realms/YOUR_REALM"
```

**Docker/Reverse Proxy Setup:**

When Keycloak and the MCP server run in Docker or behind a reverse proxy together, internal and external URLs may differ:

```bash
# Internal URL (reachable from MCP server)
export MCP_OAUTH_INTERNAL_ISSUER_URL="http://keycloak:8080/realms/YOUR_REALM"

# External URL (for client metadata)
export MCP_OAUTH_PUBLIC_ISSUER_URL="https://keycloak.example.com/realms/YOUR_REALM"
```

---

### Auth0

Auth0 supports both token introspection and userinfo validation.

**With Client Credentials (Token Introspection):**

1. Create a Machine-to-Machine application in Auth0
2. Authorize it to call your API
3. Enable token introspection in your API settings

```bash
export MCP_OAUTH_ISSUER_URL="https://YOUR_DOMAIN.auth0.com/"
export MCP_OAUTH_CLIENT_ID="your-m2m-client-id"
export MCP_OAUTH_CLIENT_SECRET="your-m2m-client-secret"
```

**Without Client Credentials (Userinfo Validation):**

```bash
export MCP_OAUTH_ISSUER_URL="https://YOUR_DOMAIN.auth0.com/"
```

**Notes:**
- Auth0 issuer URL must include the trailing slash

---

### Okta

Okta supports both token introspection and userinfo validation.

**With Client Credentials (Token Introspection):**

1. Create an application in Okta Admin Console
2. For introspection, create a "Web" application type
3. Note the client ID and secret

```bash
export MCP_OAUTH_ISSUER_URL="https://YOUR_DOMAIN.okta.com/oauth2/default"
export MCP_OAUTH_CLIENT_ID="your-client-id"
export MCP_OAUTH_CLIENT_SECRET="your-client-secret"
```

**Without Client Credentials (Userinfo Validation):**

```bash
export MCP_OAUTH_ISSUER_URL="https://YOUR_DOMAIN.okta.com/oauth2/default"
```

**Custom Authorization Server:**

If using a custom authorization server instead of the default:

```bash
export MCP_OAUTH_ISSUER_URL="https://YOUR_DOMAIN.okta.com/oauth2/YOUR_AUTH_SERVER_ID"
```

---

## Troubleshooting

### Common Issues

**"Unable to discover OIDC issuer"**
- Verify the issuer URL is correct and accessible
- Check if the `.well-known/openid-configuration` endpoint is reachable
- Ensure no network/firewall issues between the MCP server and the OAuth provider
- Increase `MCP_OAUTH_DISCOVERY_RETRIES` if the provider is slow to start

**"No userinfo endpoint available"**
- The OAuth provider's metadata doesn't include a `userinfo_endpoint`
- Provide client credentials (`MCP_OAUTH_CLIENT_ID` and `MCP_OAUTH_CLIENT_SECRET`) to use token introspection instead

**Token introspection returns "Token is not active"**
- The token has expired
- The token was issued for a different audience/resource
- Client credentials don't have permission to introspect tokens

**Userinfo validation fails**
- The access token may have expired
- The token may not have sufficient scopes (needs at least `openid`)
- Check if the provider's userinfo endpoint is accessible

### Debugging Tips

1. **Check OAuth metadata discovery:**
   ```bash
   curl https://your-issuer/.well-known/openid-configuration | jq
   ```

2. **Test userinfo endpoint manually:**
   ```bash
   curl -H "Authorization: Bearer YOUR_TOKEN" \
     https://your-issuer/userinfo
   ```

3. **Test introspection manually:**
   ```bash
   curl -X POST https://your-issuer/introspect \
     -u "client_id:client_secret" \
     -d "token=YOUR_TOKEN"
   ```

### Logging

The MCP server logs OAuth-related information to stderr:
- Validation method selection (introspection or userinfo)
- Introspection or userinfo endpoint being used
- Token validation errors with specific reasons

Run the server and check stderr output for debugging information.

---

## Security Best Practices

1. **Use HTTPS** for all OAuth endpoints in production
2. **Rotate client secrets** regularly when using introspection
3. **Set appropriate token expiration** times in your OAuth provider
4. **Use the principle of least privilege** for scopes and permissions
5. **Prefer introspection** when possible, as it provides server-side validation and immediate token revocation support
