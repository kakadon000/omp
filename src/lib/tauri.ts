// Tauri bridge — every Tauri call goes through here so the same build
// also runs as a pure web demo (GitHub Pages) with graceful fallbacks.
declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __OMP_WEB_FILE?: { name: string; url: string };
  }
}

export const isTauri =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export async function invoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>
): Promise<T | null> {
  if (!isTauri) return null;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return (await invoke<T>(cmd, args)) ?? null;
  } catch (e) {
    console.warn("invoke failed:", cmd, e);
    return null;
  }
}

export type OpenedFile = { name: string; url: string } | null;

/** Open a media file: native dialog in the app, file picker in the browser. */
export async function openMediaFile(): Promise<OpenedFile> {
  if (isTauri) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({
        multiple: false,
        filters: [
          {
            name: "Media",
            extensions: [
              "mp4", "mkv", "webm", "mov", "avi", "m4v", "wmv", "flv", "ts",
              "mp3", "flac", "m4a", "wav", "ogg", "opus", "aac",
            ],
          },
        ],
      });
      if (typeof path !== "string") return null;
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const name = path.split(/[\\/]/).pop() || "media";
      return { name, url: convertFileSrc(path) };
    } catch (e) {
      console.warn("dialog failed", e);
      return null;
    }
  }
  // web fallback
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "video/*,audio/*";
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, url: URL.createObjectURL(f) } : null);
    };
    input.click();
  });
}

export async function openImageFiles(): Promise<OpenedFile> {
  if (isTauri) {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const paths = await open({
        multiple: true,
        filters: [{ name: "Images", extensions: ["jpg", "jpeg", "png", "webp", "gif", "bmp", "ico", "svg", "avif", "tif", "tiff"] }],
      });
      if (!Array.isArray(paths) || paths.length === 0) return null;
      const { convertFileSrc } = await import("@tauri-apps/api/core");
      const first = paths[0];
      return {
        name: (first as string).split(/[\\/]/).pop() || "image",
        url: convertFileSrc(first as string),
      };
    } catch {
      return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, url: URL.createObjectURL(f) } : null);
    };
    input.click();
  });
}

/** OS / shell info from the Rust side. */
export async function getShellInfo(): Promise<{
  os: string;
  win: "10" | "11" | "other";
  version: string;
  effects: string;
}> {
  const fallback = { os: "web", win: "other" as const, version: "0.1.0", effects: "css" };
  if (!isTauri) return fallback;
  const info = await invoke<{ os: string; win: "10" | "11" | "other"; version: string; effects: string }>(
    "shell_info"
  );
  return info ?? fallback;
}

export const APP_VERSION = "0.1.0";
