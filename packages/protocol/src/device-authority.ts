import { concatBytes } from "./canonical";

export const DEVICE_AUTHORITY_VERSION = 2 as const;

export interface UnsignedDeviceCertificate {
  version: typeof DEVICE_AUTHORITY_VERSION;
  identityId: string;
  deviceId: string;
  rootPublicKey: string;
  signingPublicKey: string;
  encryptionPublicKey: string;
  issuanceSequence: number;
  issuedAt: string;
  expiresAt?: string;
}

export interface DeviceCertificate extends UnsignedDeviceCertificate {
  signature: string;
}

export interface DeviceSignature {
  publicKey: string;
  deviceCertificate: DeviceCertificate;
  signature: string;
}

const encoder = new TextEncoder();
const DOMAIN = encoder.encode("nexus:device-certificate:v2");

function frame(bytes: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + bytes.byteLength);
  new DataView(output.buffer).setUint32(0, bytes.byteLength, false);
  output.set(bytes, 4);
  return output;
}

export function canonicalDeviceCertificateBytes(
  certificate: UnsignedDeviceCertificate,
): Uint8Array {
  return concatBytes([
    frame(DOMAIN),
    frame(encoder.encode(certificate.version.toString())),
    frame(encoder.encode(certificate.identityId)),
    frame(encoder.encode(certificate.deviceId)),
    frame(encoder.encode(certificate.rootPublicKey)),
    frame(encoder.encode(certificate.signingPublicKey)),
    frame(encoder.encode(certificate.encryptionPublicKey)),
    frame(encoder.encode(certificate.issuanceSequence.toString())),
    frame(encoder.encode(certificate.issuedAt)),
    frame(encoder.encode(certificate.expiresAt ?? "")),
  ]);
}
