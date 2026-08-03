import { z } from 'zod';

import { pageMetaSchema } from './pagination';

/**
 * Response envelopes.
 *
 * Collections are wrapped so paging metadata has somewhere to live. **Single resources are
 * returned bare** — a `{ data: … }` wrapper around one object buys nothing and complicates
 * every client type (`docs/architecture/15-api-architecture.md` §3).
 */
export const linksSchema = z.object({
  next: z.string().optional(),
  prev: z.string().optional(),
});

export function collectionSchema<TItem extends z.ZodTypeAny>(item: TItem) {
  return z.object({
    data: z.array(item),
    meta: pageMetaSchema,
    links: linksSchema.optional(),
  });
}

export type Collection<TItem> = {
  data: TItem[];
  meta: z.infer<typeof pageMetaSchema>;
  links?: z.infer<typeof linksSchema>;
};

/** The shape returned by every action that only confirms it happened. */
export const acknowledgementSchema = z.object({
  id: z.string().uuid(),
  occurredAt: z.string().datetime(),
});

export type Acknowledgement = z.infer<typeof acknowledgementSchema>;
