// Demo library — clean data layer; Phase 2 swaps this for SQLite scans.
// Paths are relative to the app bundle (public/), so they work identically
// in the packaged app and on the web demo.

export type VideoItem = {
  id: string;
  title: string;
  src: string;
  poster: string;
  duration: string;
  kind: "video";
  res: string;
  codec: string;
};

export const VIDEOS: VideoItem[] = [
  {
    id: "v1", title: "OMP Sample Reel", src: "./media/sample-video.mp4",
    poster: "./gallery/shot-2.jpg", duration: "0:08", kind: "video",
    res: "960×540", codec: "H.264 / AAC",
  },
  {
    id: "v2", title: "Color Bars Test", src: "./media/sample-video-2.mp4",
    poster: "./gallery/shot-5.jpg", duration: "0:06", kind: "video",
    res: "960×540", codec: "H.264 / AAC",
  },
  {
    id: "v3", title: "Mandelbrot Zoom", src: "./media/sample-video-3.mp4",
    poster: "./gallery/shot-7.jpg", duration: "0:10", kind: "video",
    res: "960×540", codec: "H.264 / AAC",
  },
];

export type Track = {
  id: string;
  title: string;
  artist: string;
  album: string;
  src: string;
  cover: string;
  dur: string;
};

export const TRACKS: Track[] = [
  { id: "t1", title: "Blue Hours", artist: "The Glass Waves", album: "Night Tides", src: "./music/blue-hours.mp3", cover: "./music/cover-1.jpg", dur: "0:16" },
  { id: "t2", title: "Glass Rain", artist: "The Glass Waves", album: "Night Tides", src: "./music/glass-rain.mp3", cover: "./music/cover-2.jpg", dur: "0:19" },
  { id: "t3", title: "Soft Approach", artist: "Mono District", album: "Quiet Machines", src: "./music/soft-approach.mp3", cover: "./music/cover-3.jpg", dur: "0:15" },
  { id: "t4", title: "Midnight Drive", artist: "Mono District", album: "Quiet Machines", src: "./music/midnight-drive.mp3", cover: "./music/cover-4.jpg", dur: "0:14" },
];

export type Image = { id: string; name: string; src: string; w: number; h: number; size: string; folder: string };

const folders = ["Screenshots", "Wallpapers", "Projects"];
export const IMAGES: Image[] = Array.from({ length: 8 }, (_, i) => ({
  id: `g${i + 1}`,
  name: `shot-${i + 1}.jpg`,
  src: `./gallery/shot-${i + 1}.jpg`,
  w: 800, h: 500,
  size: "142 KB",
  folder: folders[i % 3],
}));

export const RADIO = [
  { id: "r1", name: "OMP Lo-Fi", genre: "Chill · 128k AAC", live: true },
  { id: "r2", name: "Night Wave", genre: "Synth · 96k MP3", live: true },
  { id: "r3", name: "Study Mono", genre: "Ambient · 128k AAC", live: true },
  { id: "r4", name: "Classic FM 98.4", genre: "Classical · 64k", live: true },
];

// Curated open-license films — embedded via YouTube's official player.
export const ONLINE_VIDEOS = [
  { id: "y1", yt: "aqz-KE-bpKQ", name: "Big Buck Bunny", src: "Blender Foundation" },
  { id: "y2", yt: "eRsGyueVLvQ", name: "Sintel", src: "Blender Foundation" },
  { id: "y3", yt: "Y-rmzh0PI3c", name: "Cosmos Laundromat", src: "Blender Foundation" },
];

export const IPTV = [
  { id: "i1", name: "Red Bull TV", genre: "Sports", status: "ready" },
  { id: "i2", name: "NASA TV Public", genre: "Science", status: "ready" },
  { id: "i3", name: "Bloomberg TV+ US", genre: "News", status: "geo" },
  { id: "i4", name: "Fashion TV Paris", genre: "Lifestyle", status: "geo" },
];
