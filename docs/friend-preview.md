# Share a meeting from your own computer

This is the fastest no-dedicated-server path for sharing Nexus with a few
friends. Your computer serves the static meeting page and encrypted rendezvous
gateway; a temporary Cloudflare Quick Tunnel supplies the public HTTPS/WSS URL.
Freenet remains independent and authoritative.

## Start

Install `cloudflared` once:

```powershell
winget install --id Cloudflare.cloudflared
```

Then, from the repository:

```powershell
pnpm friend:preview
```

The command:

1. builds the meeting-only web page and gateway;
2. creates local high-entropy gateway and host secrets under ignored
   `.runtime` storage;
3. obtains a temporary `https://…trycloudflare.com` URL;
4. starts the local gateway with only that public origin allowed;
5. mints a 24-hour encrypted meeting capability locally;
6. opens and prints the actual fragment-only meeting link.

Send friends only the printed meeting link, never the host passphrase. The
passphrase is also printed so the host can create another room later through
the page's **Share link** control.

Stop both background processes with:

```powershell
pnpm friend:stop
```

## Boundary

- Your computer must remain awake, online, and running the preview.
- Quick Tunnel URLs change when restarted and Cloudflare documents them as a
  testing/development feature without an uptime guarantee.
- WebSocket signaling is carried through the tunnel. Connection setup payloads
  remain encrypted with the key in the link fragment.
- The preview uses Cloudflare's public STUN endpoint to attempt a direct
  WebRTC route. STUN does not relay media.
- Some cellular, enterprise, or symmetric-NAT paths block direct WebRTC. Those
  paths need the optional Coturn deployment or another short-lived TURN
  credential provider; the checked-in production pilot stack supplies that
  path.

References:

- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/)
- [Cloudflare STUN/TURN service addresses](https://developers.cloudflare.com/realtime/turn/)
