import { InMemoryAttachmentRepository } from "@nexus/attachments";
import { InMemoryContractHub, InMemoryContractTransport } from "@nexus/freenet-client";
import { createLocalIdentity, type LocalIdentity } from "@nexus/identity";
import { ChatSession } from "@nexus/sync-engine";
import { ulid } from "ulid";

export interface TwoPeerPrototype {
  channelId: string;
  identities: [LocalIdentity, LocalIdentity];
  sessions: [ChatSession, ChatSession];
  attachments: InMemoryAttachmentRepository;
  setOnline(online: boolean): void;
  stop(): Promise<void>;
}

let prototypePromise: Promise<TwoPeerPrototype> | null = null;

export function createTwoPeerPrototype(): Promise<TwoPeerPrototype> {
  prototypePromise ??= buildPrototype();
  return prototypePromise;
}

async function buildPrototype(): Promise<TwoPeerPrototype> {
  const hub = new InMemoryContractHub();
  const attachments = new InMemoryAttachmentRepository();
  const channelId = ulid();
  const segmentKey = `nexus-development-segment:${channelId}`;
  const [mara, theo] = await Promise.all([
    createLocalIdentity("Mara"),
    createLocalIdentity("Theo"),
  ]);
  const firstTransport = new InMemoryContractTransport(hub, segmentKey, 45);
  const secondTransport = new InMemoryContractTransport(hub, segmentKey, 65);
  const firstSession = new ChatSession(mara, channelId, firstTransport);
  const secondSession = new ChatSession(theo, channelId, secondTransport);
  await Promise.all([firstSession.start(), secondSession.start()]);
  await firstSession.send("Okay, the first signed message made it across.");
  await secondSession.send("Confirmed. Same segment, two identities, no central database.");
  await firstSession.send("Next stop: two real Freenet nodes.");

  return {
    channelId,
    identities: [mara, theo],
    sessions: [firstSession, secondSession],
    attachments,
    setOnline(online: boolean) {
      firstTransport.setOnline(online);
      secondTransport.setOnline(online);
    },
    async stop() {
      await Promise.all([firstSession.stop(), secondSession.stop()]);
      prototypePromise = null;
    },
  };
}
