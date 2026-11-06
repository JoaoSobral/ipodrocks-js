# Library Sharing and Remote Libraries

Share chosen folders and playlists with a friend or family member who runs
**their own** iPodRocks server. Their server adds your share as a **remote
library**: they can browse it, play it, and keep tracks offline, and kept
tracks sync to their iPod like any other track.

Sharing is between **servers**, not people. Your friend never gets an account on
your server, and you never get one on theirs.

::: info Web server only
Both servers need the web server running (Settings → Remote → Web Server). The
desktop window does not show these features.
:::

## Sharing your library

1. Open **Settings → Remote → Sharing** and choose **Share my library**.
2. Name the share (who it is for). Tick the **folders** and/or **playlists** to
   share. A shared playlist follows its current contents.
3. Choose whether to **allow offline copies**. Your friend needs this to put
   your tracks on an iPod. Streaming still moves the audio, so this setting is
   honoured by their server but is not a technical barrier.
4. Optionally set a **daily transfer limit** (GB). This limit is enforced.
5. **Create invite link**, copy it, and send it to them any way you like.

The link works **once** and expires after **7 days**. Until it is used, treat it
like a password.

Each share then shows:

- who accepted it, and that server's key fingerprint;
- when it was last used;
- how much it has transferred.

**Revoke** stops the share on the very next request, and your friend's server
deletes its offline copies of your tracks.

Their server can never see:

- tracks outside the share;
- any file path on your server;
- your other playlists;
- tracks *you* keep offline from someone else's share. These are never passed
  on to a third server.

## Adding a remote library

1. Open **Library** and choose **+ Add Remote Library** (next to **+ Add Folder**).
2. Paste the invite link.
3. Tick **Their server is on my LAN or tailnet** only if it is. This allows a
   private address (192.168.x, 10.x, Tailscale 100.x) and plain `http` for that
   one server.
4. If their server is behind Cloudflare Access, add the **service token** they
   give you.
5. **Add.** The library appears with an online/offline dot, its track count and
   its key fingerprint.

The catalogue refreshes every six hours. Use **⟳** to refresh it now.
**Browse** lists the tracks by album. Tracks you already have are hidden;
**Show tracks I already have** shows them.

- **▶** plays a track through your own server.
- **Keep offline** downloads an album into your library. Kept tracks appear in
  the Tracks list, in playlists and in sync like any other track.
- **Remove offline copy** deletes them again.
- **✕** removes the remote library and every offline copy of it.

To put remote tracks on an iPod, **keep them offline first**, then sync as
usual.

Statuses:

| Status | Meaning |
|---|---|
| Online | Reachable, and proved it is the server you paired with. |
| Offline | Not reachable right now. Kept tracks still play and sync. |
| Needs attention | It answered but could not prove it is the same server, or no longer recognises yours. Ask for a new invite. |
| No longer shared | The owner revoked the share. Offline copies were deleted. |

## Making your server reachable

Only the **sharing** server has to be reachable from the other one. You do not
need to open a port on your router.

- **Cloudflare Tunnel.** This uses the tunnel you may already run for the web
  app. If Cloudflare Access protects the site, either add a **Bypass** policy
  for `/api/federation/*` (safe: every request there is signed), or create an
  Access **service token** and give it to your friend.
- **Tailscale or Headscale.** Share your server's node with your friend's
  tailnet, and limit them to the server's port with an ACL. Nothing is exposed
  to the internet. They tick **LAN or tailnet** when adding the library.

## How it is secured

- **The invite is single-use.** On first use, your server records the other
  server's public key. After that, every request is signed with that key,
  expires after five minutes and cannot be replayed.
- **Every answer is countersigned** with your server's key. If someone takes
  over the hostname, your friend's server refuses them, even if they have a
  valid certificate.
- **The address and the request are pinned.**
  - The peer's address is fixed when the invite is accepted. Moving servers
    means a new invite.
  - The recipient never follows a redirect.
  - The recipient never connects to loopback, link-local or cloud-metadata
    addresses. It reaches private addresses only for a peer marked LAN or
    tailnet.
- **Nothing a peer sends is trusted.**
  - Paths are rebuilt and kept inside the cache folder.
  - Downloads must be real audio, of the size the catalogue promised.
  - The content type comes from the file extension, never from the peer.
- **Who can do what:**
  - Only the server **owner** can create or revoke shares, and add or remove
    remote libraries.
  - Anyone signed in to a server can browse, play and keep tracks offline from
    that server's remote libraries.
