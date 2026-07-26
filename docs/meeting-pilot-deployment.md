# Private meeting pilot deployment

This runbook deploys the phone-friendly Nexus meeting surface, encrypted
rendezvous gateway, and optional TURN relay on one publicly reachable Linux
host. It deliberately runs the gateway in `meeting-only` mode and does not
claim to deploy the full Nexus/Freenet messenger.

Freenet messaging does not require this host. Freenet contracts and the
participating nodes remain authoritative. The meeting edge exists only because
ordinary phone browsers need a reachable place to download the static page,
exchange encrypted WebRTC connection setup, and—when direct peer-to-peer
connectivity is blocked—relay already-encrypted media through TURN. It stores
no canonical messages, identities, room keys, or decrypted media.

## Required infrastructure

- One publicly reachable Linux x64 or arm64 machine with Docker Engine and
  Docker Compose. This may be the operator's own always-on machine, a home
  server with port forwarding, or a VPS; it is not a central Nexus authority.
- Two DNS records pointing to its public address:
  - `meet.example.com` for HTTPS/WSS;
  - `relay.example.com` for TURN.
- Inbound TCP 80, TCP/UDP 443, TCP/UDP 3478, TCP 5349, and UDP 49160–49999.
- A valid TLS certificate and private key for the TURN name. Caddy obtains and
  renews the web certificate independently.

The relay port range must reach the host directly. Do not put it behind an HTTP
proxy or source-address-rewriting load balancer.

## Prepare the host

Clone the public repository and enter the pilot directory:

```sh
git clone https://github.com/whezzywee/nexus.git
cd nexus/deploy/pilot
cp .env.example .env
```

Edit `.env` with the real domains, public relay address, reviewed container
image tags or digests, and TURN certificate paths. Obtain the initial TURN
certificate before starting Caddy; for example, an operator may use Certbot's
standalone challenge while TCP 80 is free:

```sh
sudo certbot certonly --standalone -d relay.example.com
```

Create three independent secrets. Keep the host passphrase in a password
manager; it is the value the meeting host enters in the web page.

```sh
install -d -m 700 secrets
umask 077
openssl rand -base64 48 | tr -d '\n' > secrets/gateway_hmac_secret
openssl rand -base64 48 | tr -d '\n' > secrets/meeting_host_secret
openssl rand -base64 48 | tr -d '\n' > secrets/turn_secret
chmod 600 secrets/*
```

The files are ignored by Git and mounted as container secrets. Never put their
contents in a `VITE_` variable, image layer, issue, log, or shared meeting link.

## Start and verify

Validate and start the stack:

```sh
docker compose --env-file .env config
docker compose --env-file .env up -d --build
docker compose --env-file .env ps
```

Verify the public gateway boundary:

```sh
curl --fail --silent --show-error \
  "https://meet.example.com/nexus/v1/health"
```

The response must report `status: "ready"` and `freenet: "disabled"`. A request
to `/nexus/v1/contracts/example/updates` must return 404 or 405 because the
contract route is not registered in meeting-only mode.

Open `https://meet.example.com/`, choose **Share link**, enter the private host
passphrase, and choose **Share link** again. The recipient URL carries its
time-limited bearer capability and 256-bit room key only in the fragment after
`#`; the browser does not send that fragment in the initial HTTP request.

Before inviting a pilot group, complete this acceptance from two independent
networks:

1. Open the link on two phones, one on Wi-Fi and one on cellular data.
2. Join with media initially off.
3. Enable microphone, then camera, in both directions.
4. Confirm each phone receives live audio and video.
5. Confirm the room reports two participants and returns to one after a leave.
6. Repeat with relay-only ICE during operator acceptance to prove TURN, then
   restore the normal direct-or-relay policy.
7. Check `docker compose logs gateway coturn` for errors without copying bearer
   tokens or links into the report.

Do not call the public pilot ready if the cross-network or relay-only call has
not completed.

## Operations

- Meeting host sessions last 15 minutes; invitation links last 24 hours.
- Rooms are capped at six participants and signaling payloads are encrypted in
  the clients.
- Restart Coturn after renewing its certificate:

  ```sh
  docker compose --env-file .env restart coturn
  ```

- Monitor certificate expiry, Coturn listener/allocation health, gateway 5xx
  rate, and relay port exhaustion. Metrics remain loopback-only on port 9641.
- Rotate the host passphrase if it is shared beyond intended hosts. Rotate the
  gateway HMAC secret only when invalidating every outstanding meeting link is
  acceptable.
- Back up the Caddy volumes, `.env`, and secrets through the operator's
  encrypted infrastructure backup process. Do not commit them.

## Scope boundary

This stack is suitable for a small private meeting pilot after external phone
and TURN acceptance. It is not the complete Nexus messenger release: Freenet
messaging, device-authority protocol v2, independent review, installed-client
acceptance, signing, and multi-day soak gates remain separate release work.
