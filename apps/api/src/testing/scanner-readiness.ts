import { parseIcapUrl } from '../core/config/icap-url';
import { IcapAntivirusAdapter } from '../infrastructure/providers/icap/icap-antivirus.adapter';

/**
 * Fails a real-scanner suite at once, and says why, when the scanner is not ready.
 *
 * ClamAV takes a minute or two to load its signatures after the container starts, and until then
 * c-icap answers without a verdict. ci.yml waits for that before the integration job
 * (`infra/antivirus/probe.mjs --wait 120`); a run that does not wait used to fail here as thirteen
 * separate assertions that a CLEAN or INFECTED file came back FAILED, which reads as a defect in the
 * scanning path rather than a scanner still starting. One real probe before the suite — a scan of
 * harmless bytes, exactly the readiness check the API itself uses — turns that into one error that
 * names the cause. It does not wait or retry: waiting is the job's, as it is in CI.
 */
export async function requireReadyScanner(url: string): Promise<void> {
  const adapter = new IcapAntivirusAdapter(
    { endpoint: parseIcapUrl(url), maxBytes: 1024, timeoutMs: 10_000 },
    { read: () => Promise.resolve(null) },
  );
  try {
    await adapter.probe(10_000);
  } catch (error) {
    throw new Error(
      `The scanner at AV_ICAP_TEST_URL is not ready (${error instanceof Error ? error.message : String(error)}). ` +
        'Wait for it before running this suite, as ci.yml does: ' +
        'node infra/antivirus/probe.mjs "$AV_ICAP_TEST_URL" --wait 120',
    );
  }
}
