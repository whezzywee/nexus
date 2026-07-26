import { generateConversationKey } from "@nexus/crypto";
import { createLocalIdentity } from "@nexus/identity";
import { ulid } from "ulid";
import { describe, expect, it } from "vitest";
import {
  ATTACHMENT_CHUNK_BYTES,
  attachmentChunkParameters,
  InMemoryAttachmentRepository,
  prepareAttachment,
  restoreAttachment,
  signAttachmentIndexOperation,
  verifyAttachmentIndexOperation,
} from "./index";

describe("content-addressed attachments", () => {
  it("encrypts, chunks, verifies, and restores an attachment", async () => {
    const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 17);
    for (let offset = 0; offset < bytes.length; offset += 65_536) {
      crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65_536, bytes.length)));
    }
    const key = await generateConversationKey();
    const prepared = await prepareAttachment(bytes, "orbit.bin", "application/octet-stream", key);

    expect(prepared.manifest.chunks).toHaveLength(2);
    expect(prepared.reference).toMatch(/^nexus-attachment:[0-9a-f]{64}$/);
    expect(await restoreAttachment(prepared, key)).toEqual(bytes);
  });

  it("rejects a modified content-addressed chunk", async () => {
    const prepared = await prepareAttachment(
      new TextEncoder().encode("attachment fixture"),
      "fixture.txt",
      "text/plain",
    );
    const first = prepared.manifest.chunks[0];
    if (!first) throw new Error("Prepared attachment did not contain a chunk");
    const stored = prepared.chunks.get(first.sha256);
    if (!stored) throw new Error("Prepared attachment did not contain chunk bytes");
    stored[0] ^= 1;
    await expect(restoreAttachment(prepared)).rejects.toThrow(/failed content verification/);
  });

  it("signs an authoritative index entry and derives immutable chunk parameters", async () => {
    const identity = await createLocalIdentity("Mara");
    const prepared = await prepareAttachment(
      new TextEncoder().encode("indexed attachment"),
      "indexed.txt",
      "text/plain",
    );
    const operation = await signAttachmentIndexOperation(identity, {
      protocolVersion: 2,
      operationId: ulid(),
      targetId: ulid(),
      authorId: identity.identityId,
      authorDeviceId: identity.deviceId,
      actorSequence: identity.nextSequence,
      reference: prepared.reference,
      manifest: prepared.manifest,
      createdAt: new Date().toISOString(),
    });
    expect(await verifyAttachmentIndexOperation(operation)).toBe(true);
    const first = prepared.manifest.chunks[0];
    if (!first) throw new Error("Prepared attachment did not contain a chunk");
    expect(attachmentChunkParameters(first.sha256)).toHaveLength(32);
  });

  it("cancels an in-flight transfer and resumes safely with the same content reference", async () => {
    const identity = await createLocalIdentity("Mara");
    const repository = new InMemoryAttachmentRepository();
    const prepared = await prepareAttachment(
      new Uint8Array(ATTACHMENT_CHUNK_BYTES + 17),
      "resumable.bin",
      "application/octet-stream",
    );
    const controller = new AbortController();

    await expect(
      repository.publish(prepared, identity, ulid(), {
        signal: controller.signal,
        onProgress(completed) {
          if (completed === 1) controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    await repository.publish(prepared, identity, ulid());
    const resolved = await repository.fetch(prepared.reference);
    expect(resolved.reference).toBe(prepared.reference);
    expect(resolved.bytes).toHaveLength(ATTACHMENT_CHUNK_BYTES + 17);
  });
});
