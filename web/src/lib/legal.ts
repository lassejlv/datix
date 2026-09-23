import versions from '../../../config/legal.json';
import dpa from '../content/legal/dpa.html?raw';
import terms from '../content/legal/terms.html?raw';

export type AgreementVersion = typeof versions & { dpaSha256: string; termsSha256: string };

export type AgreementReceipt = AgreementVersion & {
  id: string;
  customerName: string;
  customerRole: 'controller' | 'processor';
  signerName: string;
  signerTitle: string;
  signerEmail: string;
  acceptedAt: string;
};

export type AgreementStatus = {
  /** Current Terms accepted, directly or by signing the DPA. This alone unlocks collection. */
  terms: { accepted: boolean; acceptedAt: string | null };
  current: AgreementVersion;
  /** Optional signed DPA for the current versions. */
  acceptance: AgreementReceipt | null;
  history: AgreementReceipt[];
};

/** Tells the agreement gate to reload after a signature elsewhere also accepted the Terms. */
export const agreementChanged = 'datix:agreement-changed';

async function digest(text: string) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

// Match the documents in this browser build to the server before allowing acceptance.
export async function matchesAgreement(current: AgreementVersion) {
  return (
    current.dpaVersion === versions.dpaVersion &&
    current.termsVersion === versions.termsVersion &&
    current.dpaSha256 === (await digest(dpa)) &&
    current.termsSha256 === (await digest(terms))
  );
}
