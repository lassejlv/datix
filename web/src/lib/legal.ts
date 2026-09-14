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
  current: AgreementVersion;
  acceptance: AgreementReceipt | null;
  history: AgreementReceipt[];
};

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
