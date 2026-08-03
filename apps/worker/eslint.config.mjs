import base from '@munaxa/config-eslint/nest.js';

/**
 * A job handler is a thin wrapper around a use case. It may not contain a business rule of
 * its own — if it does, the same action performed through the API behaves differently from
 * the same action performed by a worker, and only one of them is tested.
 */
export default [...base];
