# Cloudflare Access — bridge.yflbridge.work

## Apps
1) Self-hosted app (Protected)
   - Domain: bridge.yflbridge.work
   - Application path: /mcp*
   - Policies:
     - Include: Emails → <your Google account(s)>
     - Action: Allow
2) Self-hosted app (Bypass Health)
   - Domain: bridge.yflbridge.work
   - Application path: /health
   - Policies:
     - Action: Bypass (Everyone)

## IdP
- Google (OIDC)
- Redirect URIs: 
  - https://yourfriendlogan.cloudflareaccess.com
  - https://yourfriendlogan.cloudflareaccess.com/cdn-cgi/access/callback

## Notes
- Bypass disables Access on the matched path only; everything else remains protected.
- Named tunnel hostname continues to route via CNAME to <UUID>.cfargotunnel.com.
