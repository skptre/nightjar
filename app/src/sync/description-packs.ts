// Immutable public documents only. A failed pack never mutates the caller's rows.
export interface DescriptionReference {
  sha256: string; pack: string; pack_sha256: string; status?: string | null;
}
interface DocumentRow { description_ref?: DescriptionReference; description_text?: string }

async function digest(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class DescriptionPackCache {
  private documents = new Map<string, string>();
  private packs = new Map<string, Promise<Record<string, unknown>>>();
  private lanes: Promise<void>[] = Array.from({ length: 4 }, () => Promise.resolve());
  private nextLane = 0;
  constructor(private fetchText: (relative: string) => Promise<string>) {}

  async remember(text: string): Promise<void> {
    if (text) this.documents.set(await digest(text), text);
  }

  async get(ref: DescriptionReference): Promise<string> {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !/^[a-f0-9]{64}$/.test(ref.pack_sha256)
      || ref.pack !== `details/${ref.sha256.slice(0, 2)}-${ref.pack_sha256}.json`) {
      throw new Error('Invalid description reference');
    }
    const known = this.documents.get(ref.sha256);
    if (known !== undefined) return known;
    let pending = this.packs.get(ref.pack);
    if (!pending) {
      const lane = this.nextLane++ % this.lanes.length;
      pending = this.lanes[lane]!.then(async () => {
        const text = await this.fetchText(ref.pack);
        if (await digest(text) !== ref.pack_sha256) throw new Error('Description pack hash mismatch');
        const data: unknown = JSON.parse(text);
        if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1
          || !('documents' in data) || !data.documents || typeof data.documents !== 'object'
          || Array.isArray(data.documents)) throw new Error('Invalid description pack');
        return data.documents as Record<string, unknown>;
      });
      this.lanes[lane] = pending.then(() => {}, () => {});
      this.packs.set(ref.pack, pending);
    }
    const documents = await pending;
    const text = documents[ref.sha256];
    if (typeof text !== 'string' || await digest(text) !== ref.sha256) {
      throw new Error('Description document hash mismatch');
    }
    this.documents.set(ref.sha256, text);
    return text;
  }
}

export async function hydrateDescriptions<T extends DocumentRow>(
  postings: Record<string, T>, cache: DescriptionPackCache,
): Promise<Record<string, T & { description_text?: string }>> {
  const entries = await Promise.all(Object.entries(postings).map(async ([id, posting]) => {
    if (!posting.description_ref) return [id, posting] as const;
    const text = await cache.get(posting.description_ref);
    return [id, { ...posting, description_text: text,
      ...('status' in posting.description_ref
        ? { description_status: posting.description_ref.status ?? 'unknown' } : {}),
    }] as const;
  }));
  return Object.fromEntries(entries);
}
