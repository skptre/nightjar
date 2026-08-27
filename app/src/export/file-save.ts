import { isTauri } from '@/lib/platform';

export interface SaveFileOptions {
  content: string;
  defaultName: string;
  filters: { name: string; extensions: string[] }[];
}

export async function saveFile(options: SaveFileOptions): Promise<string | null> {
  if (isTauri()) {
    return saveTauri(options);
  }
  return saveBrowser(options);
}

async function saveTauri(options: SaveFileOptions): Promise<string | null> {
  const { save } = await import('@tauri-apps/plugin-dialog');
  const { writeTextFile } = await import('@tauri-apps/plugin-fs');

  const path = await save({
    defaultPath: options.defaultName,
    filters: options.filters,
  });

  if (!path) return null;

  await writeTextFile(path, options.content);
  return path;
}

async function saveBrowser(options: SaveFileOptions): Promise<string | null> {
  const ext = options.filters[0]?.extensions[0] ?? 'txt';
  const mimeMap: Record<string, string> = {
    csv: 'text/csv',
    json: 'application/json',
    txt: 'text/plain',
  };
  const mime = mimeMap[ext] ?? 'text/plain';

  const blob = new Blob([options.content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url;
  a.download = options.defaultName;
  document.body.appendChild(a);
  a.click();

  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  return options.defaultName;
}
