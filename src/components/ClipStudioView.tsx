import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Download,
  Eye,
  EyeOff,
  Film,
  FlipHorizontal,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  Link2,
  Link2Off,
  Magnet,
  Maximize2,
  Pause,
  Play,
  Plus,
  Redo2,
  RefreshCw,
  RotateCw,
  Scissors,
  SkipBack,
  SkipForward,
  Snowflake,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  Volume2,
  VolumeX,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  HNS_PER_SEC,
  clipsCancelExport,
  clipsCreateFolder,
  clipsDeleteFolder,
  clipsDeleteItems,
  clipsGetExportStatus,
  clipsImportDialog,
  clipsInspect,
  clipsMoveClips,
  clipsPreviewExportPlan,
  clipsRenameFolder,
  clipsScan,
  clipsStartExport,
  formatBytes,
  formatDuration,
  hnsToSec,
  onReplayClipSaved,
  replayOpenFolder,
  replayPickFolder,
  replayRevealFile,
  secToHns,
  toAssetUrl,
  type AssetItem,
  type ClipInspect,
  type ClipPieceDto,
  type ExportEditDto,
  type ExportPlanDto,
  type ExportQualityKind,
  type FadeCurveKind,
  type FolderItem,
  type FrameSizingKind,
} from "../lib/replayApi";

const MIN_LEN_HNS = 2_000_000; // 0.2s
const FREEZE_LEN_HNS = 30_000_000; // 3.0s
const MAX_UNDO = 80;
const WAVE_BUCKETS = 280;

interface TimelinePiece {
  id: number;
  path: string;
  start: number;
  len: number;
  srcIn: number;
  speed: number; // 0 = freeze frame
  gain: number; // 0..2
  muted: boolean;
  link: number; // >0 means linked video+audio pair
  fadeIn: number;
  fadeOut: number;
  curveIn: FadeCurveKind;
  curveOut: FadeCurveKind;
  turns: number;
  flip: boolean;
  crop: [number, number, number, number];
  sizing: FrameSizingKind;
}

interface TimelineTrack {
  id: number;
  kind: "video" | "audio";
  hidden: boolean;
  muted: boolean;
  clips: TimelinePiece[];
}

interface TimelineSnapshot {
  tracks: TimelineTrack[];
  markers: number[];
  ratio: [number, number] | null;
}

interface ContextMenuState {
  x: number;
  y: number;
  kind: "asset" | "folder";
  targetPath: string;
}

function cloneTracks(tracks: TimelineTrack[]): TimelineTrack[] {
  return tracks.map((t) => ({
    ...t,
    clips: t.clips.map((c) => ({ ...c, crop: [...c.crop] as [number, number, number, number] })),
  }));
}

function reflowTrack(track: TimelineTrack): TimelineTrack {
  const sorted = [...track.clips].sort((a, b) => a.start - b.start);
  let cursor = 0;
  const clips = sorted.map((c) => {
    const next = { ...c, start: cursor };
    cursor += next.len;
    return next;
  });
  return { ...track, clips };
}

function shapeCurve(curve: FadeCurveKind, x: number): number {
  const k = Math.max(0, Math.min(1, x));
  if (curve === "linear") return k;
  if (curve === "smooth") return k * k * (3 - 2 * k);
  return Math.sin((k * Math.PI) / 2);
}

function ramp(d: number, f: number): number {
  return f > 0 ? Math.max(0, Math.min(1, d / f)) : 1;
}

export function ClipStudioView() {
  // Library state
  const [rootDir, setRootDir] = useState("");
  const [currentDir, setCurrentDir] = useState<string | null>(null);
  const [folders, setFolders] = useState<FolderItem[]>([]);
  const [assets, setAssets] = useState<AssetItem[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [anchorIdx, setAnchorIdx] = useState<number | null>(null);
  const [inspectMap, setInspectMap] = useState<Record<string, ClipInspect>>({});
  const inspectingRef = useRef<Set<string>>(new Set());

  // Timeline state
  const nextIdRef = useRef(10);
  const allocId = () => {
    nextIdRef.current += 1;
    return nextIdRef.current;
  };

  const [tracks, setTracks] = useState<TimelineTrack[]>([
    { id: 1, kind: "video", hidden: false, muted: false, clips: [] },
    { id: 2, kind: "audio", hidden: false, muted: false, clips: [] },
  ]);
  const [markers, setMarkers] = useState<number[]>([]);
  const [ratio, setRatio] = useState<[number, number] | null>(null);
  const [selectedPieceId, setSelectedPieceId] = useState<number | null>(null);
  const [magnet, setMagnet] = useState(true);
  const [pxPerSec, setPxPerSec] = useState(48);
  const [undoStack, setUndoStack] = useState<TimelineSnapshot[]>([]);
  const [redoStack, setRedoStack] = useState<TimelineSnapshot[]>([]);

  // Playback state
  const [posHns, setPosHns] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loopPlayback, setLoopPlayback] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const activeSrcRef = useRef<string>("");

  // Dialogs & Menus
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const [folderModal, setFolderModal] = useState<{
    mode: "create" | "rename";
    name: string;
    renamePath?: string;
    moveFiles?: string[];
    error?: string;
  } | null>(null);
  const [deleteModal, setDeleteModal] = useState<{
    kind: "assets" | "folder";
    paths: string[];
    label: string;
  } | null>(null);

  // Export Modal & Job state
  const [exportOpen, setExportOpen] = useState(false);
  const [exportName, setExportName] = useState("");
  const [exportDir, setExportDir] = useState("");
  const [exportHeight, setExportHeight] = useState(0);
  const [exportFps, setExportFps] = useState(0);
  const [exportQuality, setExportQuality] = useState<ExportQualityKind>("recommended");
  const [exportSizeMb, setExportSizeMb] = useState(25);
  const [exportPlan, setExportPlan] = useState<ExportPlanDto | null>(null);
  const [exportRunning, setExportRunning] = useState(false);
  const [exportProgress, setExportProgress] = useState(0);
  const [banner, setBanner] = useState<{
    ok: boolean;
    text: string;
    outPath?: string;
  } | null>(null);

  // Scan Library
  const refreshLibrary = useCallback(
    async (dirOverride?: string | null) => {
      try {
        const target = dirOverride === undefined ? currentDir : dirOverride;
        const res = await clipsScan(target);
        setRootDir(res.rootDir);
        setCurrentDir(res.currentDir);
        setFolders(res.folders);
        setAssets(res.assets);
        if (!exportDir && res.rootDir) {
          setExportDir(res.rootDir);
        }
      } catch (err) {
        setBanner({
          ok: false,
          text: err instanceof Error ? err.message : String(err),
        });
      }
    },
    [currentDir, exportDir],
  );

  useEffect(() => {
    void refreshLibrary();
    let active = true;
    let unsub: (() => void) | null = null;
    void onReplayClipSaved(() => {
      if (active) void refreshLibrary();
    }).then((fn) => {
      if (!active) fn();
      else unsub = fn;
    });
    return () => {
      active = false;
      if (unsub) unsub();
    };
  }, [refreshLibrary]);

  // Background inspect of library assets (thumbnails + probe + cached waveform)
  const ensureInspect = useCallback(async (path: string, withWave = true) => {
    if (inspectingRef.current.has(path)) return;
    inspectingRef.current.add(path);
    try {
      const info = await clipsInspect(path, withWave ? WAVE_BUCKETS : 0);
      setInspectMap((prev) => ({ ...prev, [path]: info }));
    } catch {
      // Ignore unreadable corrupt external files
    } finally {
      inspectingRef.current.delete(path);
    }
  }, []);

  useEffect(() => {
    for (const a of assets.slice(0, 40)) {
      if (!inspectMap[a.path]) {
        void ensureInspect(a.path, true);
      }
    }
  }, [assets, inspectMap, ensureInspect]);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [ctxMenu]);

  // --- Timeline Helpers & Undo/Redo ---

  const pushUndo = useCallback(() => {
    setUndoStack((prev) => {
      const next = [
        ...prev,
        {
          tracks: cloneTracks(tracks),
          markers: [...markers],
          ratio: ratio ? ([...ratio] as [number, number]) : null,
        },
      ];
      return next.length > MAX_UNDO ? next.slice(next.length - MAX_UNDO) : next;
    });
    setRedoStack([]);
  }, [tracks, markers, ratio]);

  const handleUndo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const snap = prev[prev.length - 1];
      setRedoStack((r) => [
        ...r,
        {
          tracks: cloneTracks(tracks),
          markers: [...markers],
          ratio: ratio ? ([...ratio] as [number, number]) : null,
        },
      ]);
      setTracks(snap.tracks);
      setMarkers(snap.markers);
      setRatio(snap.ratio);
      return prev.slice(0, -1);
    });
  }, [tracks, markers, ratio]);

  const handleRedo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const snap = prev[prev.length - 1];
      setUndoStack((u) => [
        ...u,
        {
          tracks: cloneTracks(tracks),
          markers: [...markers],
          ratio: ratio ? ([...ratio] as [number, number]) : null,
        },
      ]);
      setTracks(snap.tracks);
      setMarkers(snap.markers);
      setRatio(snap.ratio);
      return prev.slice(0, -1);
    });
  }, [tracks, markers, ratio]);

  const totalLenHns = useMemo(() => {
    let max = 0;
    for (const t of tracks) {
      for (const c of t.clips) {
        if (c.start + c.len > max) max = c.start + c.len;
      }
    }
    return max;
  }, [tracks]);

  const usedPathsSet = useMemo(() => {
    const s = new Set<string>();
    for (const t of tracks) {
      for (const c of t.clips) s.add(c.path);
    }
    return s;
  }, [tracks]);

  const selectedGroupIds = useMemo(() => {
    if (selectedPieceId === null) return new Set<number>();
    let link = 0;
    for (const t of tracks) {
      const found = t.clips.find((c) => c.id === selectedPieceId);
      if (found) {
        link = found.link;
        break;
      }
    }
    const ids = new Set<number>([selectedPieceId]);
    if (link > 0) {
      for (const t of tracks) {
        for (const c of t.clips) {
          if (c.link === link) ids.add(c.id);
        }
      }
    }
    return ids;
  }, [tracks, selectedPieceId]);

  const selectedVideoPiece = useMemo(() => {
    for (const t of tracks) {
      if (t.kind !== "video") continue;
      for (const c of t.clips) {
        if (selectedGroupIds.has(c.id)) return c;
      }
    }
    return null;
  }, [tracks, selectedGroupIds]);

  const selectedAudioPiece = useMemo(() => {
    for (const t of tracks) {
      if (t.kind !== "audio") continue;
      for (const c of t.clips) {
        if (selectedGroupIds.has(c.id)) return c;
      }
    }
    return null;
  }, [tracks, selectedGroupIds]);

  const selectedAnyPiece = selectedVideoPiece ?? selectedAudioPiece;

  // Add Clip to Timeline
  const addClipToTimeline = useCallback(
    async (path: string) => {
      let info = inspectMap[path];
      if (!info) {
        try {
          info = await clipsInspect(path, WAVE_BUCKETS);
          setInspectMap((prev) => ({ ...prev, [path]: info }));
        } catch (err) {
          setBanner({
            ok: false,
            text: `動画を読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`,
          });
          return;
        }
      }
      if (info.probe.duration100ns <= MIN_LEN_HNS) return;

      pushUndo();
      const vidId = allocId();
      const audId = allocId();
      const linkId = info.probe.hasAudio ? allocId() : 0;

      setTracks((prev) => {
        const next = cloneTracks(prev);
        let vTrack = next.find((t) => t.kind === "video");
        if (!vTrack) {
          vTrack = { id: allocId(), kind: "video", hidden: false, muted: false, clips: [] };
          next.unshift(vTrack);
        }
        const start = vTrack.clips.reduce((m, c) => Math.max(m, c.start + c.len), 0);
        const basePiece: TimelinePiece = {
          id: vidId,
          path,
          start,
          len: info.probe.duration100ns,
          srcIn: 0,
          speed: 1.0,
          gain: 1.0,
          muted: false,
          link: linkId,
          fadeIn: 0,
          fadeOut: 0,
          curveIn: "linear",
          curveOut: "linear",
          turns: 0,
          flip: false,
          crop: [0, 0, 1, 1],
          sizing: "whole",
        };
        vTrack.clips.push(basePiece);

        if (info.probe.hasAudio) {
          let aTrack = next.find((t) => t.kind === "audio");
          if (!aTrack) {
            aTrack = { id: allocId(), kind: "audio", hidden: false, muted: false, clips: [] };
            next.push(aTrack);
          }
          aTrack.clips.push({
            ...basePiece,
            id: audId,
            curveIn: "even",
            curveOut: "even",
          });
        }
        return next;
      });

      setSelectedPieceId(vidId);
    },
    [inspectMap, pushUndo],
  );

  // Split at Playhead (`S`)
  const handleSplit = useCallback(() => {
    const t = posHns;
    // Find target piece covering playhead
    let targetIds = new Set<number>();
    if (selectedGroupIds.size > 0) {
      for (const tr of tracks) {
        for (const c of tr.clips) {
          if (selectedGroupIds.has(c.id) && c.start + MIN_LEN_HNS <= t && t <= c.start + c.len - MIN_LEN_HNS) {
            targetIds = selectedGroupIds;
          }
        }
      }
    }
    if (targetIds.size === 0) {
      for (const tr of tracks) {
        const hit = tr.clips.find((c) => c.start + MIN_LEN_HNS <= t && t <= c.start + c.len - MIN_LEN_HNS);
        if (hit) {
          targetIds.add(hit.id);
          if (hit.link > 0) {
            for (const tr2 of tracks) {
              for (const c2 of tr2.clips) {
                if (c2.link === hit.link) targetIds.add(c2.id);
              }
            }
          }
          break;
        }
      }
    }
    if (targetIds.size === 0) return;

    pushUndo();
    const newLink = targetIds.size > 1 ? allocId() : 0;
    let newSelected: number | null = null;

    setTracks((prev) =>
      cloneTracks(prev).map((tr) => {
        const out: TimelinePiece[] = [];
        for (const c of tr.clips) {
          if (
            targetIds.has(c.id) &&
            c.start + MIN_LEN_HNS <= t &&
            t <= c.start + c.len - MIN_LEN_HNS
          ) {
            const srcMid = c.srcIn + Math.round((t - c.start) * c.speed);
            const leftLen = t - c.start;
            const rightLen = c.start + c.len - t;
            const rightId = allocId();
            if (newSelected === null || tr.kind === "video") {
              newSelected = rightId;
            }
            out.push({
              ...c,
              len: leftLen,
              fadeOut: 0,
              fadeIn: Math.min(c.fadeIn, leftLen),
            });
            out.push({
              ...c,
              id: rightId,
              start: t,
              len: rightLen,
              srcIn: srcMid,
              link: newLink,
              fadeIn: 0,
              fadeOut: Math.min(c.fadeOut, rightLen),
            });
          } else {
            out.push(c);
          }
        }
        return { ...tr, clips: out };
      }),
    );

    if (newSelected !== null) setSelectedPieceId(newSelected);
  }, [posHns, tracks, selectedGroupIds, pushUndo]);

  // Freeze Frame (`F` - Clippy's `freeze()`)
  const handleFreezeFrame = useCallback(() => {
    const t = posHns;
    let vTrackIdx = -1;
    let vClipIdx = -1;
    for (let ti = 0; ti < tracks.length; ti++) {
      if (tracks[ti].kind !== "video" || tracks[ti].hidden) continue;
      const ci = tracks[ti].clips.findIndex((c) => c.start <= t && t < c.start + c.len && c.speed > 0);
      if (ci >= 0) {
        vTrackIdx = ti;
        vClipIdx = ci;
        break;
      }
    }
    if (vTrackIdx < 0) return;

    pushUndo();
    const orig = tracks[vTrackIdx].clips[vClipIdx];
    const freezeSrc = orig.srcIn + Math.round((t - orig.start) * orig.speed);
    const freezeVidId = allocId();
    const freezeAudId = allocId();
    const freezeLink = orig.link > 0 ? allocId() : 0;

    setTracks((prev) => {
      const next = cloneTracks(prev);
      const canSplit =
        t - orig.start >= MIN_LEN_HNS && orig.start + orig.len - t >= MIN_LEN_HNS;
      const insertAt = canSplit ? t : orig.start + orig.len;

      next.forEach((tr) => {
        const isTargetVideo = tr.id === prev[vTrackIdx].id;
        const isLinkedAudio =
          orig.link > 0 && tr.kind === "audio" && tr.clips.some((c) => c.link === orig.link);
        if (!isTargetVideo && !isLinkedAudio) return;

        const rebuilt: TimelinePiece[] = [];
        for (const c of tr.clips) {
          const matchesOrig =
            c.id === orig.id || (orig.link > 0 && c.link === orig.link);
          if (matchesOrig && canSplit) {
            const leftLen = t - c.start;
            const rightLen = c.start + c.len - t;
            const srcMid = c.srcIn + Math.round((t - c.start) * c.speed);
            rebuilt.push({ ...c, len: leftLen, fadeOut: 0 });
            rebuilt.push({
              ...c,
              id: isTargetVideo ? freezeVidId : freezeAudId,
              start: t,
              len: FREEZE_LEN_HNS,
              srcIn: freezeSrc,
              speed: 0,
              muted: isLinkedAudio ? true : c.muted,
              link: freezeLink,
              fadeIn: 0,
              fadeOut: 0,
            });
            rebuilt.push({
              ...c,
              id: allocId(),
              start: t + FREEZE_LEN_HNS,
              len: rightLen,
              srcIn: srcMid,
              fadeIn: 0,
            });
          } else if (matchesOrig && !canSplit) {
            rebuilt.push(c);
            rebuilt.push({
              ...c,
              id: isTargetVideo ? freezeVidId : freezeAudId,
              start: insertAt,
              len: FREEZE_LEN_HNS,
              srcIn: freezeSrc,
              speed: 0,
              muted: isLinkedAudio ? true : c.muted,
              link: freezeLink,
              fadeIn: 0,
              fadeOut: 0,
            });
          } else if (c.start >= insertAt) {
            rebuilt.push({ ...c, start: c.start + FREEZE_LEN_HNS });
          } else {
            rebuilt.push(c);
          }
        }
        tr.clips = rebuilt;
      });

      return magnet ? next.map(reflowTrack) : next;
    });
    setSelectedPieceId(freezeVidId);
  }, [posHns, tracks, magnet, pushUndo]);

  // Delete Selected Timeline Piece (`Delete`)
  const handleDeleteSelectedPiece = useCallback(() => {
    if (selectedGroupIds.size === 0) return;
    pushUndo();
    setTracks((prev) =>
      cloneTracks(prev).map((tr) => {
        const filtered = { ...tr, clips: tr.clips.filter((c) => !selectedGroupIds.has(c.id)) };
        return magnet ? reflowTrack(filtered) : filtered;
      }),
    );
    setSelectedPieceId(null);
  }, [selectedGroupIds, magnet, pushUndo]);

  // Duplicate Selected Piece (`Ctrl+D`)
  const handleDuplicateSelected = useCallback(() => {
    if (selectedGroupIds.size === 0) return;
    pushUndo();
    const newLink = selectedGroupIds.size > 1 ? allocId() : 0;
    let newSel: number | null = null;

    setTracks((prev) =>
      cloneTracks(prev).map((tr) => {
        const out: TimelinePiece[] = [];
        for (const c of tr.clips) {
          out.push(c);
          if (selectedGroupIds.has(c.id)) {
            const copyId = allocId();
            if (newSel === null || tr.kind === "video") newSel = copyId;
            out.push({
              ...c,
              id: copyId,
              start: c.start + c.len,
              link: newLink,
            });
          }
        }
        const updated = { ...tr, clips: out };
        return magnet ? reflowTrack(updated) : updated;
      }),
    );
    if (newSel !== null) setSelectedPieceId(newSel);
  }, [selectedGroupIds, magnet, pushUndo]);

  // Toggle Link/Unlink Video & Audio
  const handleToggleLink = useCallback(() => {
    if (!selectedAnyPiece) return;
    pushUndo();
    if (selectedGroupIds.size > 1) {
      // Unlink
      setTracks((prev) =>
        cloneTracks(prev).map((tr) => ({
          ...tr,
          clips: tr.clips.map((c) => (selectedGroupIds.has(c.id) ? { ...c, link: 0 } : c)),
        })),
      );
    } else {
      // Try to re-link with overlapping clip of same path on opposite track kind
      const target = selectedAnyPiece;
      const newLink = allocId();
      setTracks((prev) => {
        const next = cloneTracks(prev);
        let partnerFound = false;
        for (const tr of next) {
          for (const c of tr.clips) {
            if (c.id === target.id) continue;
            if (
              !partnerFound &&
              c.link === 0 &&
              c.path === target.path &&
              Math.abs(c.start - target.start) < HNS_PER_SEC * 2
            ) {
              c.link = newLink;
              partnerFound = true;
            }
          }
        }
        if (partnerFound) {
          for (const tr of next) {
            for (const c of tr.clips) {
              if (c.id === target.id) c.link = newLink;
            }
          }
        }
        return next;
      });
    }
  }, [selectedAnyPiece, selectedGroupIds, pushUndo]);

  // Update Inspector Properties on Selected Group
  const updateSelectedPieces = useCallback(
    (
      updater: (p: TimelinePiece, trackKind: "video" | "audio") => TimelinePiece,
      recordUndo = false,
    ) => {
      if (selectedGroupIds.size === 0) return;
      if (recordUndo) pushUndo();
      setTracks((prev) =>
        cloneTracks(prev).map((tr) => {
          const modified = {
            ...tr,
            clips: tr.clips.map((c) => (selectedGroupIds.has(c.id) ? updater(c, tr.kind) : c)),
          };
          return magnet ? reflowTrack(modified) : modified;
        }),
      );
    },
    [selectedGroupIds, magnet, pushUndo],
  );

  const handleSpeedChange = useCallback(
    (newSpeed: number, recordUndo = true) => {
      const clamped = Math.max(0.1, Math.min(10.0, newSpeed));
      updateSelectedPieces((p) => {
        if (p.speed === 0) return p;
        const srcSpan = p.len * p.speed;
        const nextLen = Math.max(MIN_LEN_HNS, Math.round(srcSpan / clamped));
        return {
          ...p,
          speed: clamped,
          len: nextLen,
          fadeIn: Math.min(p.fadeIn, nextLen),
          fadeOut: Math.min(p.fadeOut, Math.max(0, nextLen - Math.min(p.fadeIn, nextLen))),
        };
      }, recordUndo);
    },
    [updateSelectedPieces],
  );

  // Toggle Marker (`M`)
  const handleToggleMarker = useCallback(() => {
    pushUndo();
    const tol = HNS_PER_SEC * 0.25;
    setMarkers((prev) => {
      const idx = prev.findIndex((m) => Math.abs(m - posHns) <= tol);
      if (idx >= 0) {
        return prev.filter((_, i) => i !== idx);
      }
      return [...prev, posHns].sort((a, b) => a - b);
    });
  }, [posHns, pushUndo]);

  // Keyboard Shortcuts inside ClipStudio
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (exportOpen || folderModal || deleteModal) return;

      if (e.code === "Space") {
        e.preventDefault();
        if (totalLenHns > 0) {
          if (!playing && posHns >= totalLenHns - 50_000) {
            setPosHns(0);
          }
          setPlaying((p) => !p);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) handleRedo();
        else handleUndo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") {
        e.preventDefault();
        handleRedo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "d") {
        e.preventDefault();
        handleDuplicateSelected();
      } else if (e.key.toLowerCase() === "s" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleSplit();
      } else if (e.key.toLowerCase() === "f" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleFreezeFrame();
      } else if (e.key.toLowerCase() === "m" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        handleToggleMarker();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedGroupIds.size > 0) {
          e.preventDefault();
          handleDeleteSelectedPiece();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    exportOpen,
    folderModal,
    deleteModal,
    totalLenHns,
    playing,
    posHns,
    selectedGroupIds,
    handleUndo,
    handleRedo,
    handleDuplicateSelected,
    handleSplit,
    handleFreezeFrame,
    handleToggleMarker,
    handleDeleteSelectedPiece,
  ]);

  // --- Active Video & Audio Layer at `posHns` for Real-Time Preview ---

  const activeVideoAtPlayhead = useMemo(() => {
    // Topmost visible video track (reverse order, matching Clippy's `display_order`)
    const videoTracks = tracks.filter((t) => t.kind === "video" && !t.hidden);
    for (let ti = videoTracks.length - 1; ti >= 0; ti--) {
      const tr = videoTracks[ti];
      for (let ci = tr.clips.length - 1; ci >= 0; ci--) {
        const c = tr.clips[ci];
        if (c.start <= posHns && posHns < c.start + c.len) {
          const alphaIn = shapeCurve(c.curveIn, ramp(posHns - c.start, c.fadeIn));
          const alphaOut = shapeCurve(c.curveOut, ramp(c.start + c.len - posHns, c.fadeOut));
          return { piece: c, alpha: alphaIn * alphaOut };
        }
      }
    }
    return null;
  }, [tracks, posHns]);

  const activeAudioGainAtPlayhead = useMemo(() => {
    const audioTracks = tracks.filter((t) => t.kind === "audio" && !t.muted);
    for (const tr of audioTracks) {
      for (const c of tr.clips) {
        if (c.start <= posHns && posHns < c.start + c.len) {
          if (c.muted) return 0;
          const gIn = shapeCurve(c.curveIn, ramp(posHns - c.start, c.fadeIn));
          const gOut = shapeCurve(c.curveOut, ramp(c.start + c.len - posHns, c.fadeOut));
          return Math.max(0, Math.min(1, c.gain * gIn * gOut));
        }
      }
    }
    return 0;
  }, [tracks, posHns]);

  // Sync HTML5 `<video>` element with timeline clock
  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const active = activeVideoAtPlayhead?.piece;
    if (!active) {
      vid.pause();
      return;
    }

    const wantUrl = toAssetUrl(active.path);
    if (activeSrcRef.current !== wantUrl) {
      activeSrcRef.current = wantUrl;
      vid.src = wantUrl;
      vid.load();
    }

    const targetSec = hnsToSec(active.srcIn + (posHns - active.start) * active.speed);
    const drift = Math.abs(vid.currentTime - targetSec);
    if (!playing || active.speed === 0) {
      vid.pause();
      if (drift > 0.03) {
        try {
          vid.currentTime = Math.max(0, targetSec);
        } catch {
          // ignore before metadata
        }
      }
    } else {
      vid.playbackRate = Math.max(0.1, Math.min(8.0, active.speed));
      vid.volume = Math.max(0, Math.min(1, activeAudioGainAtPlayhead));
      if (drift > 0.18) {
        try {
          vid.currentTime = Math.max(0, targetSec);
        } catch {
          // ignore
        }
      }
      if (vid.paused) {
        void vid.play().catch(() => {});
      }
    }
  }, [activeVideoAtPlayhead, activeAudioGainAtPlayhead, posHns, playing]);

  // Master Timeline Playback Clock Loop
  useEffect(() => {
    if (!playing || totalLenHns <= 0) return;
    let raf = 0;
    let last = performance.now();

    const step = (now: number) => {
      const dtSec = Math.min(0.1, Math.max(0, (now - last) / 1000));
      last = now;
      setPosHns((prev) => {
        const next = prev + Math.round(dtSec * HNS_PER_SEC);
        if (next >= totalLenHns) {
          if (loopPlayback) {
            return 0;
          }
          setPlaying(false);
          return totalLenHns;
        }
        return next;
      });
      raf = window.requestAnimationFrame(step);
    };

    raf = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(raf);
  }, [playing, totalLenHns, loopPlayback]);

  // --- Export Engine Hooks ---

  const buildExportEditDto = useCallback((): ExportEditDto => {
    const videoTracks: ClipPieceDto[][] = tracks
      .filter((t) => t.kind === "video" && !t.hidden)
      .map((t) =>
        t.clips.map((c) => ({
          id: c.id,
          path: c.path,
          start: c.start,
          len: c.len,
          srcIn: c.srcIn,
          speed: c.speed,
          fadeIn: c.fadeIn,
          fadeOut: c.fadeOut,
          gain: 0,
          curveIn: c.curveIn,
          curveOut: c.curveOut,
          turns: c.turns,
          flip: c.flip,
          crop: c.crop,
          sizing: c.sizing,
        })),
      );

    const audioTracks: ClipPieceDto[][] = tracks
      .filter((t) => t.kind === "audio" && !t.muted)
      .map((t) =>
        t.clips
          .filter((c) => !c.muted && c.gain > 0)
          .map((c) => ({
            id: c.id,
            path: c.path,
            start: c.start,
            len: c.len,
            srcIn: c.srcIn,
            speed: c.speed,
            fadeIn: c.fadeIn,
            fadeOut: c.fadeOut,
            gain: c.gain,
            curveIn: c.curveIn,
            curveOut: c.curveOut,
            turns: 0,
            flip: false,
            crop: [0, 0, 1, 1],
            sizing: "whole",
          })),
      );

    return {
      videoTracks,
      audioTracks,
      ratio,
    };
  }, [tracks, ratio]);

  // Recompute Export Plan whenever export dialog options change
  useEffect(() => {
    if (!exportOpen || totalLenHns <= 0) return;
    let active = true;
    void clipsPreviewExportPlan({
      edit: buildExportEditDto(),
      name: exportName || "Clip_Edit",
      dir: exportDir || rootDir,
      height: exportHeight,
      fps: exportFps,
      quality: exportQuality,
      sizeMb: exportSizeMb,
    })
      .then((p) => {
        if (active) setExportPlan(p);
      })
      .catch(() => {
        if (active) setExportPlan(null);
      });
    return () => {
      active = false;
    };
  }, [
    exportOpen,
    totalLenHns,
    buildExportEditDto,
    exportName,
    exportDir,
    rootDir,
    exportHeight,
    exportFps,
    exportQuality,
    exportSizeMb,
  ]);

  // Poll Active Export Progress
  useEffect(() => {
    if (!exportRunning) return;
    const id = window.setInterval(async () => {
      try {
        const st = await clipsGetExportStatus();
        setExportProgress(st.progress);
        if (!st.active) {
          setExportRunning(false);
          if (st.finishedMode) {
            setExportOpen(false);
            setBanner({
              ok: true,
              text: `書き出し完了 (${st.finishedMode})`,
              outPath: st.outPath ?? undefined,
            });
            void refreshLibrary();
          } else if (st.error) {
            setBanner({ ok: false, text: st.error });
          }
        }
      } catch {
        setExportRunning(false);
      }
    }, 120);
    return () => window.clearInterval(id);
  }, [exportRunning, refreshLibrary]);

  const openExportModal = () => {
    if (totalLenHns <= 0) return;
    setPlaying(false);
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}-${String(
      now.getMinutes(),
    ).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}`;
    setExportName(`Edit_${stamp}`);
    if (!exportDir && rootDir) setExportDir(rootDir);
    setExportOpen(true);
  };

  const startExportJob = async () => {
    try {
      setExportProgress(0);
      setExportRunning(true);
      await clipsStartExport({
        edit: buildExportEditDto(),
        name: exportName.trim() || "Clip_Edit",
        dir: exportDir || rootDir,
        height: exportHeight,
        fps: exportFps,
        quality: exportQuality,
        sizeMb: exportSizeMb,
      });
    } catch (err) {
      setExportRunning(false);
      setBanner({
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      });
    }
  };

  // --- Timeline Pointer Dragging (Playhead Scrub, Left/Right Trim, Clip Move) ---

  const timelineScrollRef = useRef<HTMLDivElement | null>(null);
  const TRACK_HEADER_W = 118;

  const xToHns = (clientX: number): number => {
    const el = timelineScrollRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const relX = clientX - rect.left + el.scrollLeft - TRACK_HEADER_W;
    return Math.max(0, Math.round((relX / pxPerSec) * HNS_PER_SEC));
  };

  const startScrubPlayhead = (e: ReactMouseEvent) => {
    if (e.button !== 0) return;
    setPlaying(false);
    setPosHns(Math.min(Math.max(totalLenHns, HNS_PER_SEC * 5), xToHns(e.clientX)));
    const onMove = (ev: MouseEvent) => {
      setPosHns(Math.min(Math.max(totalLenHns, HNS_PER_SEC * 5), xToHns(ev.clientX)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startTrimDrag = (
    e: ReactMouseEvent,
    piece: TimelinePiece,
    side: "left" | "right",
  ) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    pushUndo();
    setSelectedPieceId(piece.id);
    const startX = e.clientX;
    const origSrcIn = piece.srcIn;
    const origLen = piece.len;
    const origStart = piece.start;
    const maxSrc = inspectMap[piece.path]?.probe.duration100ns ?? origSrcIn + origLen * piece.speed;

    const groupIds = new Set<number>([piece.id]);
    if (piece.link > 0) {
      for (const tr of tracks) {
        for (const c of tr.clips) {
          if (c.link === piece.link) groupIds.add(c.id);
        }
      }
    }

    const onMove = (ev: MouseEvent) => {
      const dxSec = (ev.clientX - startX) / pxPerSec;
      const deltaHns = Math.round(dxSec * HNS_PER_SEC);

      setTracks((prev) =>
        cloneTracks(prev).map((tr) => {
          const updated = {
            ...tr,
            clips: tr.clips.map((c) => {
              if (!groupIds.has(c.id)) return c;
              if (side === "right") {
                const maxLineLen =
                  c.speed === 0
                    ? HNS_PER_SEC * 60
                    : Math.floor((maxSrc - origSrcIn) / c.speed);
                const nextLen = Math.max(
                  MIN_LEN_HNS,
                  Math.min(maxLineLen, origLen + deltaHns),
                );
                return {
                  ...c,
                  len: nextLen,
                  fadeIn: Math.min(c.fadeIn, nextLen),
                  fadeOut: Math.min(c.fadeOut, Math.max(0, nextLen - Math.min(c.fadeIn, nextLen))),
                };
              } else {
                if (c.speed === 0) {
                  const nextLen = Math.max(MIN_LEN_HNS, origLen - deltaHns);
                  return { ...c, start: Math.max(0, origStart + (origLen - nextLen)), len: nextLen };
                }
                const minDelta = -Math.floor(origSrcIn / c.speed);
                const maxDelta = origLen - MIN_LEN_HNS;
                const d = Math.max(minDelta, Math.min(maxDelta, deltaHns));
                const nextSrcIn = Math.max(0, origSrcIn + Math.round(d * c.speed));
                const nextLen = Math.max(MIN_LEN_HNS, origLen - d);
                return {
                  ...c,
                  start: magnet ? c.start : Math.max(0, origStart + d),
                  srcIn: nextSrcIn,
                  len: nextLen,
                  fadeIn: Math.min(c.fadeIn, nextLen),
                  fadeOut: Math.min(c.fadeOut, Math.max(0, nextLen - Math.min(c.fadeIn, nextLen))),
                };
              }
            }),
          };
          return magnet ? reflowTrack(updated) : updated;
        }),
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const startMovePieceDrag = (e: ReactMouseEvent, piece: TimelinePiece) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setSelectedPieceId(piece.id);
    const startX = e.clientX;
    const origStart = piece.start;
    let moved = false;

    const groupIds = new Set<number>([piece.id]);
    if (piece.link > 0) {
      for (const tr of tracks) {
        for (const c of tr.clips) {
          if (c.link === piece.link) groupIds.add(c.id);
        }
      }
    }

    const onMove = (ev: MouseEvent) => {
      if (Math.abs(ev.clientX - startX) < 4 && !moved) return;
      if (!moved) {
        moved = true;
        pushUndo();
      }
      const deltaHns = Math.round(((ev.clientX - startX) / pxPerSec) * HNS_PER_SEC);
      const nextStart = Math.max(0, origStart + deltaHns);

      setTracks((prev) =>
        cloneTracks(prev).map((tr) => {
          const updated = {
            ...tr,
            clips: tr.clips.map((c) => (groupIds.has(c.id) ? { ...c, start: nextStart } : c)),
          };
          return magnet ? reflowTrack(updated) : { ...updated, clips: [...updated.clips].sort((a, b) => a.start - b.start) };
        }),
      );
    };

    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  // Determine canvas preview aspect ratio
  const firstVideoProbe = useMemo(() => {
    for (const tr of tracks) {
      if (tr.kind === "video" && tr.clips.length > 0) {
        return inspectMap[tr.clips[0].path]?.probe ?? null;
      }
    }
    return null;
  }, [tracks, inspectMap]);

  const canvasAspectCss = useMemo(() => {
    if (ratio) return `${ratio[0]} / ${ratio[1]}`;
    if (firstVideoProbe && firstVideoProbe.width > 0 && firstVideoProbe.height > 0) {
      return `${firstVideoProbe.width} / ${firstVideoProbe.height}`;
    }
    return "16 / 9";
  }, [ratio, firstVideoProbe]);

  const timelineWidthPx = Math.max(
    680,
    Math.ceil((Math.max(totalLenHns, HNS_PER_SEC * 15) / HNS_PER_SEC) * pxPerSec) + 140,
  );

  const activePiece = activeVideoAtPlayhead?.piece ?? null;
  const [cropL, cropT, cropR, cropB] = activePiece?.crop ?? [0, 0, 1, 1];
  const hasCrop =
    cropL > 0.001 || cropT > 0.001 || cropR < 0.999 || cropB < 0.999;

  return (
    <div className="h-[calc(100vh-3.5rem)] flex flex-col overflow-hidden select-none">
      {/* Top Notification Banner */}
      {banner && (
        <div className="mx-4 mt-2 px-4 py-2 rounded-[10px] bg-[#121212]/95 vt-hairline flex items-center justify-between gap-3 shrink-0 z-20">
          <div className="flex items-center gap-2 text-xs min-w-0">
            {banner.ok ? (
              <Check className="w-4 h-4 text-[#ededed] shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-[#8f8f8f] shrink-0" />
            )}
            <span className="truncate text-[#ededed]">{banner.text}</span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {banner.outPath && (
              <button
                type="button"
                onClick={() => void replayRevealFile(banner.outPath!)}
                className="px-2.5 py-1 rounded-[7px] bg-[#ededed] text-[#0a0a0a] text-[11px] font-medium hover:bg-white cursor-pointer"
              >
                エクスプローラーで表示
              </button>
            )}
            <button
              type="button"
              onClick={() => setBanner(null)}
              className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Upper 3-Column Workspace: Library | Video Preview | Inspector */}
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {/* LEFT COLUMN: CLIP LIBRARY & FOLDERS */}
        <section className="w-72 lg:w-80 shrink-0 bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline-r flex flex-col min-h-0">
          {/* Library Header */}
          <div className="h-11 px-3.5 flex items-center justify-between gap-2 vt-hairline-b shrink-0">
            <div className="flex items-center gap-1.5 min-w-0">
              {currentDir ? (
                <>
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPaths([]);
                      void refreshLibrary(null);
                    }}
                    title="ライブラリに戻る"
                    className="p-1 rounded hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                  </button>
                  <span className="text-xs font-semibold text-[#ededed] truncate">
                    {currentDir.split(/[\\/]/).pop()}
                  </span>
                </>
              ) : (
                <span className="text-xs font-semibold text-[#ededed]">クリップライブラリ</span>
              )}
            </div>

            <div className="flex items-center gap-1 shrink-0">
              {!currentDir && (
                <button
                  type="button"
                  title="新規フォルダ作成"
                  onClick={() =>
                    setFolderModal({ mode: "create", name: "新規フォルダ" })
                  }
                  className="p-1.5 rounded-[7px] hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                >
                  <FolderPlus className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                type="button"
                title="外部の動画ファイルをインポート"
                onClick={async () => {
                  const added = await clipsImportDialog();
                  if (added.length > 0) void refreshLibrary();
                }}
                className="px-2 py-1 rounded-[7px] bg-white/[0.06] hover:bg-white/[0.11] text-[#ededed] text-[11px] flex items-center gap-1 cursor-pointer"
              >
                <Upload className="w-3 h-3" />
                <span>追加</span>
              </button>
              <button
                type="button"
                title="保存先フォルダを開く"
                onClick={() => void replayOpenFolder(currentDir ?? rootDir)}
                className="p-1.5 rounded-[7px] hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                title="再読み込み"
                onClick={() => void refreshLibrary()}
                className="p-1.5 rounded-[7px] hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Library Grid */}
          <div
            className="flex-1 overflow-y-auto p-3 space-y-2"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                setSelectedPaths([]);
                setAnchorIdx(null);
              }
            }}
          >
            {!currentDir && folders.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {folders.map((f) => (
                  <div
                    key={f.path}
                    onClick={() => {
                      setSelectedPaths([]);
                      void refreshLibrary(f.path);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCtxMenu({
                        x: e.clientX,
                        y: e.clientY,
                        kind: "folder",
                        targetPath: f.path,
                      });
                    }}
                    className="group rounded-[10px] bg-[#121212] hover:bg-[#191919] vt-hairline p-2.5 cursor-pointer transition-colors"
                  >
                    <div className="flex items-center gap-2">
                      <Folder className="w-4 h-4 text-[#8f8f8f] group-hover:text-[#ededed] shrink-0" />
                      <span className="text-xs font-medium text-[#ededed] truncate">
                        {f.name}
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-[#5c5c5c] font-num">
                      {f.count} 本の動画
                    </div>
                  </div>
                ))}
              </div>
            )}

            {assets.length === 0 ? (
              <div className="py-12 px-4 text-center space-y-2">
                <Film className="w-7 h-7 text-[#5c5c5c] mx-auto" />
                <div className="text-xs font-medium text-[#ededed]">
                  {currentDir ? "このフォルダは空です" : "まだクリップがありません"}
                </div>
                <p className="text-[11px] text-[#5c5c5c] leading-relaxed">
                  {currentDir
                    ? "ライブラリの動画を右クリックして「フォルダへ移動」で整理できます"
                    : "ゲーム中に F9 キーを押してリプレイ保存するか、右上の「追加」から動画を取り込めます"}
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                {assets.map((asset, idx) => {
                  const info = inspectMap[asset.path];
                  const isSelected = selectedPaths.includes(asset.path);
                  const isUsed = usedPathsSet.has(asset.path);

                  return (
                    <div
                      key={asset.path}
                      onClick={(e) => {
                        if (e.shiftKey && anchorIdx !== null) {
                          const lo = Math.min(anchorIdx, idx);
                          const hi = Math.max(anchorIdx, idx);
                          const range = assets.slice(lo, hi + 1).map((x) => x.path);
                          setSelectedPaths((prev) =>
                            e.ctrlKey || e.metaKey
                              ? Array.from(new Set([...prev, ...range]))
                              : range,
                          );
                        } else if (e.ctrlKey || e.metaKey) {
                          setSelectedPaths((prev) =>
                            prev.includes(asset.path)
                              ? prev.filter((p) => p !== asset.path)
                              : [...prev, asset.path],
                          );
                          setAnchorIdx(idx);
                        } else {
                          setSelectedPaths([asset.path]);
                          setAnchorIdx(idx);
                        }
                      }}
                      onDoubleClick={() => void addClipToTimeline(asset.path)}
                      onContextMenu={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!selectedPaths.includes(asset.path)) {
                          setSelectedPaths([asset.path]);
                          setAnchorIdx(idx);
                        }
                        setCtxMenu({
                          x: e.clientX,
                          y: e.clientY,
                          kind: "asset",
                          targetPath: asset.path,
                        });
                      }}
                      title={`${asset.title}\nダブルクリックまたは「＋」でタイムラインに追加`}
                      className={`group rounded-[10px] overflow-hidden border transition-all cursor-pointer ${
                        isSelected
                          ? "bg-[#191919] border-[#ededed]"
                          : "bg-[#111111] border-[rgba(255,255,255,0.08)] hover:border-white/25"
                      }`}
                    >
                      {/* Thumbnail */}
                      <div className="relative aspect-video bg-[#080808] overflow-hidden">
                        {info?.thumbPath ? (
                          <img
                            src={toAssetUrl(info.thumbPath)}
                            alt={asset.title}
                            className="w-full h-full object-cover"
                            loading="lazy"
                          />
                        ) : (
                          <div className="w-full h-full flex items-center justify-center text-[10px] text-[#5c5c5c]">
                            読込中…
                          </div>
                        )}

                        {/* Used in timeline badge */}
                        {isUsed && (
                          <span className="absolute top-1.5 left-1.5 w-4 h-4 rounded-full bg-[#ededed] text-[#0a0a0a] flex items-center justify-center">
                            <Check className="w-2.5 h-2.5 stroke-[3]" />
                          </span>
                        )}

                        {/* Quick + Add to Timeline button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            void addClipToTimeline(asset.path);
                          }}
                          title="タイムラインに追加"
                          className="opacity-0 group-hover:opacity-100 absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-[#ededed] hover:bg-white text-[#0a0a0a] flex items-center justify-center transition-opacity cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 stroke-[2.5]" />
                        </button>

                        {/* Duration pill */}
                        {info?.probe && (
                          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/80 text-[10px] font-num text-[#ededed]">
                            {formatDuration(info.probe.durationSec)}
                          </span>
                        )}
                      </div>

                      {/* Metadata */}
                      <div className="p-2 space-y-0.5">
                        <div className="text-[11px] font-medium text-[#ededed] truncate">
                          {asset.title}
                        </div>
                        <div className="text-[10px] text-[#5c5c5c] font-num truncate">
                          {formatBytes(asset.size)}
                          {info?.probe
                            ? ` · ${info.probe.height}p ${Math.round(info.probe.fps)}f`
                            : ""}
                          {asset.imported ? " · 外部" : ""}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Selection Action Bar */}
          {selectedPaths.length > 0 && (
            <div className="px-3 py-2 vt-hairline-t bg-[#0f0f0f] flex items-center justify-between gap-2 shrink-0">
              <span className="text-[11px] text-[#8f8f8f] font-num">
                {selectedPaths.length} 件選択中
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    for (const p of selectedPaths) void addClipToTimeline(p);
                  }}
                  className="px-2.5 py-1 rounded-[7px] bg-[#ededed] text-[#0a0a0a] text-[11px] font-medium hover:bg-white flex items-center gap-1 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>追加</span>
                </button>
                <button
                  type="button"
                  title="削除（ごみ箱へ移動）"
                  onClick={() =>
                    setDeleteModal({
                      kind: "assets",
                      paths: selectedPaths,
                      label: `${selectedPaths.length} 件の動画`,
                    })
                  }
                  className="p-1.5 rounded-[7px] bg-white/[0.05] hover:bg-white/[0.12] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}
        </section>

        {/* CENTER COLUMN: VIDEO PREVIEW & TRANSPORT */}
        <section className="flex-1 min-w-0 flex flex-col bg-black/55 backdrop-blur-sm">
          {/* Preview Top Bar */}
          <div className="h-11 px-4 flex items-center justify-between gap-3 vt-hairline-b shrink-0">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={undoStack.length === 0}
                onClick={handleUndo}
                title="元に戻す (Ctrl+Z)"
                className="p-1.5 rounded-[7px] hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <Undo2 className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={redoStack.length === 0}
                onClick={handleRedo}
                title="やり直す (Ctrl+Y)"
                className="p-1.5 rounded-[7px] hover:bg-white/[0.07] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <Redo2 className="w-3.5 h-3.5" />
              </button>

              <div className="h-4 w-px bg-white/[0.09] mx-1" />

              {/* Aspect Ratio Selector */}
              <div className="flex items-center gap-0.5 p-0.5 rounded-[8px] bg-[#111111] vt-hairline">
                {(
                  [
                    { label: "元の比率", val: null },
                    { label: "16:9", val: [16, 9] as [number, number] },
                    { label: "9:16", val: [9, 16] as [number, number] },
                    { label: "1:1", val: [1, 1] as [number, number] },
                    { label: "4:3", val: [4, 3] as [number, number] },
                  ] as const
                ).map((opt) => {
                  const active =
                    (opt.val === null && ratio === null) ||
                    (opt.val !== null &&
                      ratio !== null &&
                      opt.val[0] === ratio[0] &&
                      opt.val[1] === ratio[1]);
                  return (
                    <button
                      key={opt.label}
                      type="button"
                      onClick={() => {
                        pushUndo();
                        setRatio(opt.val ? ([...opt.val] as [number, number]) : null);
                      }}
                      className={`px-2 py-1 rounded-[6px] text-[11px] font-num transition-colors cursor-pointer ${
                        active
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <button
              type="button"
              disabled={totalLenHns <= 0 || exportRunning}
              onClick={openExportModal}
              className="h-8 px-3.5 rounded-[8px] bg-[#ededed] hover:bg-white text-[#0a0a0a] text-xs font-medium disabled:opacity-35 disabled:cursor-not-allowed flex items-center gap-1.5 transition-colors cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{exportRunning ? `書き出し中 ${Math.round(exportProgress * 100)}%` : "動画を書き出し"}</span>
            </button>
          </div>

          {/* Center Video Stage */}
          <div className="flex-1 min-h-0 p-4 flex items-center justify-center overflow-hidden">
            {totalLenHns <= 0 ? (
              <div className="text-center space-y-3 max-w-sm">
                <div className="w-12 h-12 rounded-[12px] bg-[#111111] vt-hairline flex items-center justify-center mx-auto">
                  <Film className="w-5 h-5 text-[#8f8f8f]" />
                </div>
                <div className="space-y-1">
                  <div className="text-sm font-medium text-[#ededed]">
                    タイムラインにクリップを追加して編集を開始
                  </div>
                  <p className="text-xs text-[#8f8f8f] leading-relaxed">
                    左のライブラリからクリップをダブルクリックするか、「＋」ボタンで複数クリップの結合・トリミング・速度変更・Discord用サイズ指定書き出しが行えます
                  </p>
                </div>
                {selectedPaths.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      for (const p of selectedPaths) void addClipToTimeline(p);
                    }}
                    className="h-9 px-4 rounded-[9px] bg-[#ededed] text-[#0a0a0a] text-xs font-medium hover:bg-white inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>選択中のクリップをタイムラインに追加</span>
                  </button>
                )}
              </div>
            ) : (
              <div
                style={{ aspectRatio: canvasAspectCss }}
                className="relative max-h-full max-w-full bg-[#050505] rounded-[8px] overflow-hidden border border-white/[0.12] flex items-center justify-center"
              >
                <video
                  ref={videoRef}
                  playsInline
                  muted={false}
                  onClick={() => setPlaying((p) => !p)}
                  style={{
                    objectFit:
                      activePiece?.sizing === "fill"
                        ? "cover"
                        : activePiece?.sizing === "stretch"
                          ? "fill"
                          : "contain",
                    transform: activePiece
                      ? `rotate(${(activePiece.turns % 4) * 90}deg) scaleX(${
                          activePiece.flip ? -1 : 1
                        })`
                      : undefined,
                    clipPath: hasCrop
                      ? `inset(${(cropT * 100).toFixed(1)}% ${((1 - cropR) * 100).toFixed(1)}% ${(
                          (1 - cropB) *
                          100
                        ).toFixed(1)}% ${(cropL * 100).toFixed(1)}%)`
                      : undefined,
                    opacity: activeVideoAtPlayhead ? activeVideoAtPlayhead.alpha : 0,
                  }}
                  className="w-full h-full cursor-pointer"
                />
              </div>
            )}
          </div>

          {/* Transport & Editing Action Bar */}
          <div className="h-11 px-4 vt-hairline-t bg-[#0a0a0a]/90 flex items-center justify-between gap-3 shrink-0">
            {/* Left Edit Tools */}
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={totalLenHns <= 0}
                onClick={handleSplit}
                title="再生位置で分割 (S)"
                className="h-7 px-2.5 rounded-[7px] bg-white/[0.05] hover:bg-white/[0.1] text-[#ededed] text-[11px] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Scissors className="w-3 h-3" />
                <span>分割</span>
              </button>
              <button
                type="button"
                disabled={totalLenHns <= 0}
                onClick={handleFreezeFrame}
                title="再生位置のフレームを3秒静止挿入 (F)"
                className="h-7 px-2.5 rounded-[7px] bg-white/[0.05] hover:bg-white/[0.1] text-[#ededed] text-[11px] disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
              >
                <Snowflake className="w-3 h-3" />
                <span>静止画</span>
              </button>
              <button
                type="button"
                disabled={selectedGroupIds.size === 0}
                onClick={handleDuplicateSelected}
                title="選択クリップを複製 (Ctrl+D)"
                className="h-7 px-2 rounded-[7px] hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={selectedGroupIds.size === 0}
                onClick={handleDeleteSelectedPiece}
                title="選択クリップを削除 (Delete)"
                className="h-7 px-2 rounded-[7px] hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Center Playback Controls */}
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={totalLenHns <= 0}
                onClick={() => {
                  setPlaying(false);
                  setPosHns(0);
                }}
                className="p-1.5 rounded hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <SkipBack className="w-3.5 h-3.5" />
              </button>
              <button
                type="button"
                disabled={totalLenHns <= 0}
                onClick={() => {
                  if (!playing && posHns >= totalLenHns - 50_000) {
                    setPosHns(0);
                  }
                  setPlaying((p) => !p);
                }}
                className="w-8 h-8 rounded-full bg-[#ededed] hover:bg-white text-[#0a0a0a] disabled:opacity-35 flex items-center justify-center cursor-pointer"
              >
                {playing ? (
                  <Pause className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current ml-0.5" />
                )}
              </button>
              <button
                type="button"
                disabled={totalLenHns <= 0}
                onClick={() => {
                  setPlaying(false);
                  setPosHns(totalLenHns);
                }}
                className="p-1.5 rounded hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-30 cursor-pointer"
              >
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Right Timecode */}
            <div className="flex items-center gap-2 font-num text-xs">
              <span className="text-[#ededed]">
                {formatDuration(hnsToSec(posHns), true)}
              </span>
              <span className="text-[#5c5c5c]">/</span>
              <span className="text-[#8f8f8f]">
                {formatDuration(hnsToSec(totalLenHns), true)}
              </span>
              <button
                type="button"
                onClick={() => setLoopPlayback((v) => !v)}
                className={`ml-1 px-2 py-0.5 rounded text-[10px] border cursor-pointer ${
                  loopPlayback
                    ? "bg-white/[0.1] text-[#ededed] border-white/25"
                    : "text-[#5c5c5c] border-white/[0.08] hover:text-[#8f8f8f]"
                }`}
              >
                LOOP
              </button>
            </div>
          </div>
        </section>

        {/* RIGHT COLUMN: CLIP INSPECTOR (Frame, Crop, Speed, Volume, Fades, Link) */}
        <aside className="w-64 lg:w-72 shrink-0 bg-[#0a0a0a]/84 backdrop-blur-md vt-hairline-l flex flex-col min-h-0">
          <div className="h-11 px-4 flex items-center justify-between vt-hairline-b shrink-0">
            <span className="text-xs font-semibold text-[#ededed]">クリップ調整</span>
            {selectedAnyPiece && (
              <button
                type="button"
                onClick={handleToggleLink}
                title={
                  selectedGroupIds.size > 1
                    ? "映像と音声のリンクを分離する"
                    : "映像と音声を再リンクする"
                }
                className="px-2 py-1 rounded-[7px] bg-white/[0.06] hover:bg-white/[0.11] text-[11px] text-[#ededed] flex items-center gap-1 cursor-pointer"
              >
                {selectedGroupIds.size > 1 ? (
                  <>
                    <Link2 className="w-3 h-3" />
                    <span>リンク中</span>
                  </>
                ) : (
                  <>
                    <Link2Off className="w-3 h-3 text-[#8f8f8f]" />
                    <span>分離中</span>
                  </>
                )}
              </button>
            )}
          </div>

          {!selectedAnyPiece ? (
            <div className="p-5 text-xs text-[#5c5c5c] space-y-3 leading-relaxed">
              <p>
                下のタイムラインでクリップをクリックすると、音量・再生速度・フェード・回転・クロップを調整できます。
              </p>
              <div className="pt-2 space-y-1.5 font-num text-[11px] text-[#8f8f8f]">
                <div>Space : 再生 / 一時停止</div>
                <div>S : 再生位置で分割</div>
                <div>F : フレーム静止画挿入</div>
                <div>M : マーカー追加 / 削除</div>
                <div>Ctrl+D : クリップ複製</div>
                <div>Ctrl+Z / Y : 元に戻す / やり直す</div>
                <div>Delete : 選択クリップ削除</div>
              </div>
            </div>
          ) : (
            <div className="flex-1 overflow-y-auto p-4 space-y-5 text-xs">
              {/* Playback Speed */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-[#8f8f8f] font-medium">再生速度</span>
                  <span className="font-num text-[#ededed]">
                    {selectedAnyPiece.speed === 0
                      ? "静止画"
                      : `${selectedAnyPiece.speed.toFixed(2)}x`}
                  </span>
                </div>
                {selectedAnyPiece.speed > 0 && (
                  <>
                    <div className="grid grid-cols-5 gap-1">
                      {[0.25, 0.5, 1, 1.5, 2].map((sp) => (
                        <button
                          key={sp}
                          type="button"
                          onClick={() => handleSpeedChange(sp, true)}
                          className={`py-1 rounded-[6px] font-num text-[11px] border cursor-pointer ${
                            Math.abs(selectedAnyPiece.speed - sp) < 0.01
                              ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                              : "bg-[#121212] text-[#8f8f8f] border-white/[0.08] hover:text-[#ededed]"
                          }`}
                        >
                          {sp}x
                        </button>
                      ))}
                    </div>
                    <input
                      type="range"
                      min={0.25}
                      max={4}
                      step={0.05}
                      value={Math.min(4, selectedAnyPiece.speed)}
                      onMouseDown={pushUndo}
                      onChange={(e) => handleSpeedChange(Number(e.target.value), false)}
                      className="w-full accent-[#ededed] cursor-pointer"
                    />
                  </>
                )}
              </div>

              {/* Audio Volume & Mute */}
              {selectedAudioPiece && (
                <div className="space-y-2.5 pt-3 vt-hairline-t">
                  <div className="flex items-center justify-between">
                    <span className="text-[#8f8f8f] font-medium">クリップ音量</span>
                    <div className="flex items-center gap-2">
                      <span className="font-num text-[#ededed]">
                        {selectedAudioPiece.muted
                          ? "ミュート"
                          : `${Math.round(selectedAudioPiece.gain * 100)}%`}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          updateSelectedPieces(
                            (p, kind) =>
                              kind === "audio" ? { ...p, muted: !p.muted } : p,
                            true,
                          )
                        }
                        className="p-1 rounded bg-white/[0.06] hover:bg-white/[0.12] text-[#ededed] cursor-pointer"
                      >
                        {selectedAudioPiece.muted ? (
                          <VolumeX className="w-3.5 h-3.5" />
                        ) : (
                          <Volume2 className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    step={1}
                    value={Math.round(selectedAudioPiece.gain * 100)}
                    onMouseDown={pushUndo}
                    onChange={(e) => {
                      const g = Number(e.target.value) / 100;
                      updateSelectedPieces(
                        (p, kind) => (kind === "audio" ? { ...p, gain: g, muted: false } : p),
                        false,
                      );
                    }}
                    className="w-full accent-[#ededed] cursor-pointer"
                  />
                </div>
              )}

              {/* Fade In / Fade Out & Curve */}
              <div className="space-y-2.5 pt-3 vt-hairline-t">
                <div className="text-[#8f8f8f] font-medium">フェードイン / アウト</div>
                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-[#8f8f8f]">フェードイン</span>
                    <span className="font-num text-[#ededed]">
                      {hnsToSec(selectedAnyPiece.fadeIn).toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.min(5, hnsToSec(selectedAnyPiece.len))}
                    step={0.1}
                    value={hnsToSec(selectedAnyPiece.fadeIn)}
                    onMouseDown={pushUndo}
                    onChange={(e) => {
                      const fi = secToHns(Number(e.target.value));
                      updateSelectedPieces(
                        (p) => ({
                          ...p,
                          fadeIn: Math.min(fi, p.len),
                          fadeOut: Math.min(p.fadeOut, Math.max(0, p.len - fi)),
                        }),
                        false,
                      );
                    }}
                    className="w-full accent-[#ededed] cursor-pointer"
                  />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-[11px]">
                    <span className="text-[#8f8f8f]">フェードアウト</span>
                    <span className="font-num text-[#ededed]">
                      {hnsToSec(selectedAnyPiece.fadeOut).toFixed(1)}s
                    </span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={Math.min(5, hnsToSec(selectedAnyPiece.len))}
                    step={0.1}
                    value={hnsToSec(selectedAnyPiece.fadeOut)}
                    onMouseDown={pushUndo}
                    onChange={(e) => {
                      const fo = secToHns(Number(e.target.value));
                      updateSelectedPieces(
                        (p) => ({
                          ...p,
                          fadeOut: Math.min(fo, Math.max(0, p.len - p.fadeIn)),
                        }),
                        false,
                      );
                    }}
                    className="w-full accent-[#ededed] cursor-pointer"
                  />
                </div>

                <div className="grid grid-cols-3 gap-1 pt-1">
                  {(
                    [
                      { id: "even", label: "一定出力" },
                      { id: "linear", label: "リニア" },
                      { id: "smooth", label: "スムーズ" },
                    ] as Array<{ id: FadeCurveKind; label: string }>
                  ).map((cv) => (
                    <button
                      key={cv.id}
                      type="button"
                      onClick={() =>
                        updateSelectedPieces(
                          (p) => ({ ...p, curveIn: cv.id, curveOut: cv.id }),
                          true,
                        )
                      }
                      className={`py-1 rounded-[6px] text-[10px] border cursor-pointer ${
                        selectedAnyPiece.curveIn === cv.id
                          ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                          : "bg-[#121212] text-[#8f8f8f] border-white/[0.08] hover:text-[#ededed]"
                      }`}
                    >
                      {cv.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Video Frame Transform (Sizing, Rotate, Flip, Crop) */}
              {selectedVideoPiece && (
                <div className="space-y-3 pt-3 vt-hairline-t">
                  <div className="text-[#8f8f8f] font-medium">画面配置・変形</div>
                  <div className="grid grid-cols-3 gap-1">
                    {(
                      [
                        { id: "whole", label: "全体表示" },
                        { id: "fill", label: "拡大フィット" },
                        { id: "stretch", label: "引き伸ばし" },
                      ] as Array<{ id: FrameSizingKind; label: string }>
                    ).map((sz) => (
                      <button
                        key={sz.id}
                        type="button"
                        onClick={() =>
                          updateSelectedPieces(
                            (p, kind) => (kind === "video" ? { ...p, sizing: sz.id } : p),
                            true,
                          )
                        }
                        className={`py-1.5 rounded-[6px] text-[10px] border cursor-pointer ${
                          selectedVideoPiece.sizing === sz.id
                            ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                            : "bg-[#121212] text-[#8f8f8f] border-white/[0.08] hover:text-[#ededed]"
                        }`}
                      >
                        {sz.label}
                      </button>
                    ))}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        updateSelectedPieces(
                          (p, kind) =>
                            kind === "video" ? { ...p, turns: (p.turns + 1) % 4 } : p,
                          true,
                        )
                      }
                      className="flex-1 h-8 rounded-[7px] bg-[#121212] hover:bg-[#1a1a1a] text-[#ededed] vt-hairline flex items-center justify-center gap-1.5 cursor-pointer"
                    >
                      <RotateCw className="w-3.5 h-3.5" />
                      <span>90°回転 ({(selectedVideoPiece.turns % 4) * 90}°)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        updateSelectedPieces(
                          (p, kind) => (kind === "video" ? { ...p, flip: !p.flip } : p),
                          true,
                        )
                      }
                      className={`h-8 px-3 rounded-[7px] border flex items-center gap-1.5 cursor-pointer ${
                        selectedVideoPiece.flip
                          ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                          : "bg-[#121212] text-[#8f8f8f] border-white/[0.08] hover:text-[#ededed]"
                      }`}
                    >
                      <FlipHorizontal className="w-3.5 h-3.5" />
                      <span>反転</span>
                    </button>
                  </div>

                  {/* Crop Sliders */}
                  <div className="space-y-2 pt-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-[#8f8f8f]">クロップ（切り抜き）</span>
                      <button
                        type="button"
                        onClick={() =>
                          updateSelectedPieces(
                            (p, kind) =>
                              kind === "video" ? { ...p, crop: [0, 0, 1, 1] } : p,
                            true,
                          )
                        }
                        className="text-[10px] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                      >
                        リセット
                      </button>
                    </div>
                    {(
                      [
                        { idx: 0, label: "左", min: 0, max: 0.45 },
                        { idx: 1, label: "上", min: 0, max: 0.45 },
                        { idx: 2, label: "右", min: 0.55, max: 1.0 },
                        { idx: 3, label: "下", min: 0.55, max: 1.0 },
                      ] as const
                    ).map((edge) => (
                      <div key={edge.label} className="flex items-center gap-2">
                        <span className="w-4 text-[10px] text-[#5c5c5c]">{edge.label}</span>
                        <input
                          type="range"
                          min={edge.min}
                          max={edge.max}
                          step={0.01}
                          value={selectedVideoPiece.crop[edge.idx]}
                          onMouseDown={pushUndo}
                          onChange={(e) => {
                            const val = Number(e.target.value);
                            updateSelectedPieces((p, kind) => {
                              if (kind !== "video") return p;
                              const nextCrop = [...p.crop] as [number, number, number, number];
                              nextCrop[edge.idx] = val;
                              return { ...p, crop: nextCrop };
                            }, false);
                          }}
                          className="flex-1 accent-[#ededed] cursor-pointer"
                        />
                        <span className="w-9 text-right font-num text-[10px] text-[#8f8f8f]">
                          {Math.round(selectedVideoPiece.crop[edge.idx] * 100)}%
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </aside>
      </div>

      {/* BOTTOM WORKSPACE: MULTI-TRACK TIMELINE WITH WAVEFORMS & TRIM HANDLES */}
      <section className="h-56 shrink-0 bg-[#080808]/95 backdrop-blur-md vt-hairline-t flex flex-col">
        {/* Timeline Toolbar */}
        <div className="h-9 px-3 flex items-center justify-between gap-3 vt-hairline-b shrink-0">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setMagnet((m) => !m)}
              title={
                magnet
                  ? "マグネット吸着 ON（隙間なく自動整列）"
                  : "マグネット吸着 OFF（自由配置・重ねてクロスフェード）"
              }
              className={`h-6 px-2.5 rounded-[6px] text-[11px] flex items-center gap-1.5 border cursor-pointer ${
                magnet
                  ? "bg-[#ededed] text-[#0a0a0a] border-[#ededed] font-medium"
                  : "bg-[#121212] text-[#8f8f8f] border-white/[0.08] hover:text-[#ededed]"
              }`}
            >
              <Magnet className="w-3 h-3" />
              <span>吸着 {magnet ? "ON" : "OFF"}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                if (tracks.filter((t) => t.kind === "video").length >= 4) return;
                pushUndo();
                setTracks((prev) => [
                  ...prev,
                  { id: allocId(), kind: "video", hidden: false, muted: false, clips: [] },
                ]);
              }}
              className="h-6 px-2 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.09] text-[11px] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              + 映像トラック
            </button>
            <button
              type="button"
              onClick={() => {
                if (tracks.filter((t) => t.kind === "audio").length >= 4) return;
                pushUndo();
                setTracks((prev) => [
                  ...prev,
                  { id: allocId(), kind: "audio", hidden: false, muted: false, clips: [] },
                ]);
              }}
              className="h-6 px-2 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.09] text-[11px] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              + 音声トラック
            </button>
            <button
              type="button"
              onClick={handleToggleMarker}
              className="h-6 px-2 rounded-[6px] bg-white/[0.04] hover:bg-white/[0.09] text-[11px] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              マーカー (M)
            </button>
          </div>

          {/* Zoom Controls */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.max(8, Math.round(z * 0.75)))}
              className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              <ZoomOut className="w-3.5 h-3.5" />
            </button>
            <input
              type="range"
              min={8}
              max={200}
              value={pxPerSec}
              onChange={(e) => setPxPerSec(Number(e.target.value))}
              className="w-24 accent-[#ededed] cursor-pointer"
            />
            <button
              type="button"
              onClick={() => setPxPerSec((z) => Math.min(200, Math.round(z * 1.35)))}
              className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              <ZoomIn className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              title="全体を表示"
              onClick={() => {
                const el = timelineScrollRef.current;
                if (!el || totalLenHns <= 0) return;
                const avail = Math.max(240, el.clientWidth - TRACK_HEADER_W - 40);
                setPxPerSec(
                  Math.max(8, Math.min(200, Math.floor(avail / hnsToSec(totalLenHns)))),
                );
              }}
              className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
            >
              <Maximize2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Scrollable Tracks + Time Ruler */}
        <div
          ref={timelineScrollRef}
          className="flex-1 overflow-auto relative"
          onClick={(e) => {
            if (e.target === e.currentTarget) setSelectedPieceId(null);
          }}
        >
          <div style={{ width: timelineWidthPx + TRACK_HEADER_W }} className="min-h-full relative">
            {/* Time Ruler */}
            <div
              onMouseDown={startScrubPlayhead}
              className="sticky top-0 z-10 h-6 bg-[#0d0d0d] vt-hairline-b flex items-center cursor-ew-resize"
            >
              <div
                style={{ width: TRACK_HEADER_W }}
                className="shrink-0 h-full px-3 flex items-center text-[10px] font-num text-[#5c5c5c] bg-[#0d0d0d] vt-hairline-r sticky left-0 z-20"
              >
                TIMELINE
              </div>
              <div className="relative flex-1 h-full">
                {renderRulerTicks(timelineWidthPx, pxPerSec)}
                {markers.map((m) => (
                  <div
                    key={m}
                    style={{ left: hnsToSec(m) * pxPerSec }}
                    title={`マーカー ${formatDuration(hnsToSec(m), true)}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      setPosHns(m);
                    }}
                    className="absolute top-0 bottom-0 w-0.5 bg-[#ededed] cursor-pointer"
                  >
                    <span className="block w-2 h-2 -ml-[3px] rotate-45 bg-[#ededed]" />
                  </div>
                ))}
              </div>
            </div>

            {/* Track Rows (Video tracks top-to-bottom, then Audio tracks) */}
            {[
              ...tracks.filter((t) => t.kind === "video").reverse(),
              ...tracks.filter((t) => t.kind === "audio"),
            ].map((track, displayIdx) => {
              const sameKindList = tracks.filter((t) => t.kind === track.kind);
              const kindNum = sameKindList.findIndex((t) => t.id === track.id) + 1;
              const canRemove =
                track.kind === "audio" || sameKindList.length > 1;

              return (
                <div
                  key={track.id}
                  className="h-14 vt-hairline-b flex items-stretch relative"
                >
                  {/* Sticky Track Header */}
                  <div
                    style={{ width: TRACK_HEADER_W }}
                    className="sticky left-0 z-10 shrink-0 bg-[#0c0c0c] vt-hairline-r px-2.5 flex items-center justify-between gap-1"
                  >
                    <span className="text-[11px] font-medium text-[#8f8f8f] truncate font-num">
                      {track.kind === "video" ? `V${kindNum} 映像` : `A${kindNum} 音声`}
                    </span>
                    <div className="flex items-center gap-0.5">
                      {track.kind === "video" ? (
                        <button
                          type="button"
                          onClick={() => {
                            pushUndo();
                            setTracks((prev) =>
                              prev.map((t) =>
                                t.id === track.id ? { ...t, hidden: !t.hidden } : t,
                              ),
                            );
                          }}
                          className="p-1 rounded hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                        >
                          {track.hidden ? (
                            <EyeOff className="w-3 h-3 text-[#5c5c5c]" />
                          ) : (
                            <Eye className="w-3 h-3" />
                          )}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => {
                            pushUndo();
                            setTracks((prev) =>
                              prev.map((t) =>
                                t.id === track.id ? { ...t, muted: !t.muted } : t,
                              ),
                            );
                          }}
                          className="p-1 rounded hover:bg-white/[0.08] text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                        >
                          {track.muted ? (
                            <VolumeX className="w-3 h-3 text-[#5c5c5c]" />
                          ) : (
                            <Volume2 className="w-3 h-3" />
                          )}
                        </button>
                      )}
                      {canRemove && track.clips.length === 0 && displayIdx >= 0 && (
                        <button
                          type="button"
                          onClick={() => {
                            pushUndo();
                            setTracks((prev) => prev.filter((t) => t.id !== track.id));
                          }}
                          className="p-1 rounded hover:bg-white/[0.08] text-[#5c5c5c] hover:text-[#ededed] cursor-pointer"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Track Lane */}
                  <div
                    onMouseDown={(e) => {
                      if (e.target === e.currentTarget) {
                        setSelectedPieceId(null);
                        setPosHns(Math.min(totalLenHns, xToHns(e.clientX)));
                      }
                    }}
                    className={`relative flex-1 h-full ${
                      track.hidden || track.muted ? "opacity-45" : ""
                    }`}
                  >
                    {track.clips.map((piece) => {
                      const leftPx = hnsToSec(piece.start) * pxPerSec;
                      const widthPx = Math.max(12, hnsToSec(piece.len) * pxPerSec);
                      const isSel = selectedGroupIds.has(piece.id);
                      const info = inspectMap[piece.path];
                      const title =
                        assets.find((a) => a.path === piece.path)?.title ??
                        piece.path.split(/[\\/]/).pop() ??
                        "Clip";

                      return (
                        <div
                          key={piece.id}
                          onMouseDown={(e) => startMovePieceDrag(e, piece)}
                          style={{ left: leftPx, width: widthPx }}
                          className={`group/clip absolute top-1.5 bottom-1.5 rounded-[7px] overflow-hidden border transition-colors cursor-grab active:cursor-grabbing ${
                            isSel
                              ? "bg-[#222222] border-[#ededed] z-10"
                              : track.kind === "video"
                                ? "bg-[#161616] border-white/[0.14] hover:border-white/30"
                                : "bg-[#131618] border-white/[0.12] hover:border-white/25"
                          }`}
                        >
                          {/* Audio Waveform Canvas */}
                          {track.kind === "audio" && info && info.peaks.length > 0 && (
                            <WaveformCanvas
                              peaks={info.peaks}
                              rms={info.rms}
                              totalDurationHns={info.probe.duration100ns}
                              srcIn={piece.srcIn}
                              srcOut={piece.srcIn + Math.round(piece.len * piece.speed)}
                              gain={piece.muted ? 0 : piece.gain}
                              widthPx={Math.ceil(widthPx)}
                            />
                          )}

                          {/* Clip Label */}
                          <div className="relative z-10 px-2.5 py-1 flex items-center justify-between gap-1 pointer-events-none">
                            <span className="text-[10px] font-medium text-[#ededed] truncate">
                              {title}
                            </span>
                            {(piece.speed !== 1 || piece.muted) && (
                              <span className="font-num text-[9px] px-1 rounded bg-black/60 text-[#ededed] shrink-0">
                                {piece.speed === 0
                                  ? "静止"
                                  : piece.muted
                                    ? "MUTE"
                                    : `${piece.speed}x`}
                              </span>
                            )}
                          </div>

                          {/* Left Trim Handle */}
                          <div
                            onMouseDown={(e) => startTrimDrag(e, piece, "left")}
                            title="左端をドラッグして開始位置をトリミング"
                            className="absolute left-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-[#ededed]/70 cursor-ew-resize z-20 flex items-center justify-center"
                          >
                            <span className="w-0.5 h-4 rounded bg-white/40" />
                          </div>

                          {/* Right Trim Handle */}
                          <div
                            onMouseDown={(e) => startTrimDrag(e, piece, "right")}
                            title="右端をドラッグして終了位置をトリミング"
                            className="absolute right-0 top-0 bottom-0 w-2 bg-white/0 hover:bg-[#ededed]/70 cursor-ew-resize z-20 flex items-center justify-center"
                          >
                            <span className="w-0.5 h-4 rounded bg-white/40" />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {/* Playhead Vertical Line */}
            {totalLenHns > 0 && (
              <div
                style={{ left: TRACK_HEADER_W + hnsToSec(posHns) * pxPerSec }}
                className="pointer-events-none absolute top-0 bottom-0 w-[1.5px] bg-[#ededed] z-20"
              >
                <div className="w-2.5 h-2.5 -ml-[4px] rounded-full bg-[#ededed]" />
              </div>
            )}
          </div>
        </div>
      </section>

      {/* CUSTOM MONOCHROME CONTEXT MENU */}
      {ctxMenu && (
        <div
          style={{
            left: Math.min(ctxMenu.x, window.innerWidth - 220),
            top: Math.min(ctxMenu.y, window.innerHeight - 240),
          }}
          onClick={(e) => e.stopPropagation()}
          className="fixed z-50 w-52 rounded-[10px] bg-[#121212] border border-white/[0.14] p-1.5 text-xs text-[#ededed] space-y-0.5"
        >
          {ctxMenu.kind === "asset" ? (
            <>
              <button
                type="button"
                onClick={() => {
                  const targets = selectedPaths.length > 0 ? selectedPaths : [ctxMenu.targetPath];
                  setCtxMenu(null);
                  for (const p of targets) void addClipToTimeline(p);
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>タイムラインに追加</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.targetPath;
                  setCtxMenu(null);
                  void replayRevealFile(p);
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>エクスプローラーで表示</span>
              </button>

              {currentDir && (
                <button
                  type="button"
                  onClick={async () => {
                    const targets =
                      selectedPaths.length > 0 ? selectedPaths : [ctxMenu.targetPath];
                    setCtxMenu(null);
                    await clipsMoveClips(targets, rootDir);
                    setSelectedPaths([]);
                    void refreshLibrary();
                  }}
                  className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
                >
                  <FolderInput className="w-3.5 h-3.5" />
                  <span>ルートフォルダへ戻す</span>
                </button>
              )}

              {folders
                .filter((f) => f.path !== currentDir)
                .map((f) => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={async () => {
                      const targets =
                        selectedPaths.length > 0 ? selectedPaths : [ctxMenu.targetPath];
                      setCtxMenu(null);
                      await clipsMoveClips(targets, f.path);
                      setSelectedPaths([]);
                      void refreshLibrary();
                    }}
                    className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
                  >
                    <Folder className="w-3.5 h-3.5 text-[#8f8f8f]" />
                    <span className="truncate">「{f.name}」へ移動</span>
                  </button>
                ))}

              <button
                type="button"
                onClick={() => {
                  const targets =
                    selectedPaths.length > 0 ? selectedPaths : [ctxMenu.targetPath];
                  setCtxMenu(null);
                  setFolderModal({
                    mode: "create",
                    name: "新規フォルダ",
                    moveFiles: targets,
                  });
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5 text-[#8f8f8f]" />
                <span>新規フォルダを作って移動…</span>
              </button>

              <div className="h-px bg-white/[0.08] my-1" />

              <button
                type="button"
                onClick={() => {
                  const targets =
                    selectedPaths.length > 0 ? selectedPaths : [ctxMenu.targetPath];
                  setCtxMenu(null);
                  setDeleteModal({
                    kind: "assets",
                    paths: targets,
                    label: `${targets.length} 件の動画`,
                  });
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] text-[#ededed] flex items-center gap-2 text-left cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5 text-[#8f8f8f]" />
                <span>削除（ごみ箱へ移動）…</span>
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.targetPath;
                  setCtxMenu(null);
                  void refreshLibrary(p);
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                <span>開く</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.targetPath;
                  const curName = p.split(/[\\/]/).pop() ?? "";
                  setCtxMenu(null);
                  setFolderModal({ mode: "rename", name: curName, renamePath: p });
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <span>名前を変更…</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.targetPath;
                  setCtxMenu(null);
                  void replayOpenFolder(p);
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <span>エクスプローラーで開く</span>
              </button>
              <div className="h-px bg-white/[0.08] my-1" />
              <button
                type="button"
                onClick={() => {
                  const p = ctxMenu.targetPath;
                  const curName = p.split(/[\\/]/).pop() ?? "";
                  setCtxMenu(null);
                  setDeleteModal({
                    kind: "folder",
                    paths: [p],
                    label: `フォルダ「${curName}」`,
                  });
                }}
                className="w-full px-2.5 py-1.5 rounded-[7px] hover:bg-white/[0.08] flex items-center gap-2 text-left cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5 text-[#8f8f8f]" />
                <span>フォルダをごみ箱へ…</span>
              </button>
            </>
          )}
        </div>
      )}

      {/* FOLDER CREATE / RENAME MODAL */}
      {folderModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-[12px] bg-[#0e0e0e] vt-hairline p-5 space-y-4">
            <div className="text-sm font-semibold text-[#ededed]">
              {folderModal.mode === "rename" ? "フォルダ名を変更" : "新規フォルダ作成"}
            </div>
            <input
              type="text"
              autoFocus
              value={folderModal.name}
              onChange={(e) =>
                setFolderModal((prev) => (prev ? { ...prev, name: e.target.value, error: undefined } : prev))
              }
              onKeyDown={async (e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  try {
                    if (folderModal.mode === "rename" && folderModal.renamePath) {
                      await clipsRenameFolder(folderModal.renamePath, folderModal.name);
                    } else {
                      await clipsCreateFolder(folderModal.name, folderModal.moveFiles ?? []);
                    }
                    setFolderModal(null);
                    setSelectedPaths([]);
                    void refreshLibrary();
                  } catch (err) {
                    setFolderModal((prev) =>
                      prev
                        ? { ...prev, error: err instanceof Error ? err.message : String(err) }
                        : prev,
                    );
                  }
                }
              }}
              className="w-full h-9 px-3 rounded-[8px] bg-[#161616] text-xs text-[#ededed] vt-hairline outline-none"
            />
            {folderModal.error && (
              <div className="text-xs text-[#ededed] bg-white/[0.05] px-3 py-2 rounded-[8px]">
                {folderModal.error}
              </div>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setFolderModal(null)}
                className="h-8 px-3.5 rounded-[8px] bg-[#161616] text-xs text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    if (folderModal.mode === "rename" && folderModal.renamePath) {
                      await clipsRenameFolder(folderModal.renamePath, folderModal.name);
                    } else {
                      await clipsCreateFolder(folderModal.name, folderModal.moveFiles ?? []);
                    }
                    setFolderModal(null);
                    setSelectedPaths([]);
                    void refreshLibrary();
                  } catch (err) {
                    setFolderModal((prev) =>
                      prev
                        ? { ...prev, error: err instanceof Error ? err.message : String(err) }
                        : prev,
                    );
                  }
                }}
                className="h-8 px-4 rounded-[8px] bg-[#ededed] text-[#0a0a0a] text-xs font-medium hover:bg-white cursor-pointer"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}

      {/* RECYCLE BIN DELETE CONFIRMATION MODAL */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-[12px] bg-[#0e0e0e] vt-hairline p-5 space-y-4">
            <div className="text-sm font-semibold text-[#ededed]">
              {deleteModal.label} を削除しますか？
            </div>
            <p className="text-xs text-[#8f8f8f] leading-relaxed">
              録画ファイルは Windows の「ごみ箱」に移動されるため、誤って削除しても復元可能です（インポートした外部動画はリストから除外されるだけで元ファイルは残ります）。
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setDeleteModal(null)}
                className="h-8 px-3.5 rounded-[8px] bg-[#161616] text-xs text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
              >
                キャンセル
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    const gone = new Set(deleteModal.paths);
                    if (deleteModal.kind === "folder") {
                      await clipsDeleteFolder(deleteModal.paths[0]);
                      if (currentDir === deleteModal.paths[0]) {
                        setCurrentDir(null);
                      }
                    } else {
                      await clipsDeleteItems(deleteModal.paths);
                      setTracks((prev) =>
                        cloneTracks(prev).map((tr) => ({
                          ...tr,
                          clips: tr.clips.filter((c) => !gone.has(c.path)),
                        })),
                      );
                    }
                    setDeleteModal(null);
                    setSelectedPaths([]);
                    void refreshLibrary();
                  } catch (err) {
                    setDeleteModal(null);
                    setBanner({
                      ok: false,
                      text: err instanceof Error ? err.message : String(err),
                    });
                  }
                }}
                className="h-8 px-4 rounded-[8px] bg-[#ededed] text-[#0a0a0a] text-xs font-medium hover:bg-white cursor-pointer"
              >
                ごみ箱へ移動
              </button>
            </div>
          </div>
        </div>
      )}

      {/* HARDWARE GPU / LOSSLESS EXPORT MODAL (Port of Clippy's `export.rs`) */}
      {exportOpen && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-xl rounded-[12px] bg-[#0c0c0c] vt-hairline p-6 space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-[#ededed]">動画を書き出し</h2>
                <p className="text-xs text-[#8f8f8f]">
                  無劣化ストリームコピー、またはGPUハードウェア高速エンコードでMP4を保存します
                </p>
              </div>
              {!exportRunning && (
                <button
                  type="button"
                  onClick={() => setExportOpen(false)}
                  className="p-1 text-[#8f8f8f] hover:text-[#ededed] cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>

            <div className="space-y-3.5 text-xs">
              {/* File Name */}
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8f8f8f] w-28 shrink-0">ファイル名</span>
                <div className="flex-1 flex items-center gap-1.5">
                  <input
                    type="text"
                    disabled={exportRunning}
                    value={exportName}
                    onChange={(e) => setExportName(e.target.value)}
                    className="flex-1 h-9 px-3 rounded-[8px] bg-[#151515] text-[#ededed] vt-hairline outline-none font-num"
                  />
                  <span className="text-[#5c5c5c] font-num">.mp4</span>
                </div>
              </div>

              {/* Save Destination */}
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8f8f8f] w-28 shrink-0">保存先</span>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                  <span className="flex-1 truncate font-num text-[#8f8f8f] bg-[#121212] px-3 py-2 rounded-[8px] vt-hairline">
                    {exportDir || rootDir}
                  </span>
                  <button
                    type="button"
                    disabled={exportRunning}
                    onClick={async () => {
                      const picked = await replayPickFolder(exportDir || rootDir);
                      if (picked) setExportDir(picked);
                    }}
                    className="h-9 px-3 rounded-[8px] bg-[#161616] hover:bg-[#1f1f1f] text-[#ededed] vt-hairline shrink-0 cursor-pointer"
                  >
                    変更…
                  </button>
                </div>
              </div>

              {/* Resolution */}
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8f8f8f] w-28 shrink-0">解像度</span>
                <div className="flex-1 flex items-center gap-1 p-1 rounded-[8px] bg-[#121212] vt-hairline">
                  {[
                    { val: 0, label: "オリジナル" },
                    { val: 1440, label: "1440p" },
                    { val: 1080, label: "1080p" },
                    { val: 720, label: "720p" },
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      type="button"
                      disabled={exportRunning}
                      onClick={() => setExportHeight(opt.val)}
                      className={`flex-1 py-1.5 rounded-[6px] font-num transition-colors cursor-pointer ${
                        exportHeight === opt.val
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* FPS */}
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8f8f8f] w-28 shrink-0">フレームレート</span>
                <div className="flex-1 flex items-center gap-1 p-1 rounded-[8px] bg-[#121212] vt-hairline">
                  {[
                    { val: 0, label: "オリジナル" },
                    { val: 60, label: "60 fps" },
                    { val: 30, label: "30 fps" },
                  ].map((opt) => (
                    <button
                      key={opt.val}
                      type="button"
                      disabled={exportRunning}
                      onClick={() => setExportFps(opt.val)}
                      className={`flex-1 py-1.5 rounded-[6px] font-num transition-colors cursor-pointer ${
                        exportFps === opt.val
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Quality / Discord Max Size */}
              <div className="flex items-center justify-between gap-4">
                <span className="text-[#8f8f8f] w-28 shrink-0">品質モード</span>
                <div className="flex-1 flex items-center gap-1 p-1 rounded-[8px] bg-[#121212] vt-hairline flex-wrap">
                  {(
                    [
                      { id: "recommended", label: "推奨" },
                      { id: "high", label: "高画質" },
                      { id: "medium", label: "標準" },
                      { id: "low", label: "軽量" },
                      { id: "maxsize", label: "サイズ指定" },
                    ] as Array<{ id: ExportQualityKind; label: string }>
                  ).map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      disabled={exportRunning}
                      onClick={() => setExportQuality(q.id)}
                      className={`flex-1 py-1.5 px-2 rounded-[6px] transition-colors cursor-pointer whitespace-nowrap ${
                        exportQuality === q.id
                          ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                          : "text-[#8f8f8f] hover:text-[#ededed]"
                      }`}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>

              {exportQuality === "maxsize" && (
                <div className="flex items-center justify-between gap-4">
                  <span className="text-[#8f8f8f] w-28 shrink-0">最大ファイルサイズ</span>
                  <div className="flex-1 flex items-center gap-1 p-1 rounded-[8px] bg-[#121212] vt-hairline">
                    {[10, 25, 50, 100].map((mb) => (
                      <button
                        key={mb}
                        type="button"
                        disabled={exportRunning}
                        onClick={() => setExportSizeMb(mb)}
                        className={`flex-1 py-1.5 rounded-[6px] font-num transition-colors cursor-pointer ${
                          exportSizeMb === mb
                            ? "bg-[#ededed] text-[#0a0a0a] font-medium"
                            : "text-[#8f8f8f] hover:text-[#ededed]"
                        }`}
                      >
                        {mb} MB
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Export Plan Live Summary */}
              {exportPlan && (
                <div className="rounded-[10px] bg-[#131313] vt-hairline p-3.5 space-y-1.5">
                  <div className="flex items-center justify-between font-num">
                    <span className="text-xs font-medium text-[#ededed]">
                      {exportPlan.width}×{exportPlan.height} · {Math.round(exportPlan.fps)} fps
                      {exportPlan.canLosslessCopy
                        ? " · 元映像そのまま"
                        : ` · ${(exportPlan.bitrate / 1e6).toFixed(1)} Mbps H.264`}
                    </span>
                    <span className="text-sm font-semibold text-[#ededed]">
                      ~{formatBytes(exportPlan.estimatedBytes)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-[11px] text-[#8f8f8f]">
                    <Sparkles className="w-3.5 h-3.5 text-[#ededed] shrink-0" />
                    <span>
                      {exportPlan.canLosslessCopy
                        ? "再エンコードなしの無劣化ストリームコピーで1秒以内に保存されます"
                        : `GPUハードウェアエンコードで書き出します（長さ ${formatDuration(
                            exportPlan.durationSec,
                          )}）`}
                    </span>
                  </div>
                  {exportPlan.lowQualityWarning && (
                    <div className="text-[11px] text-[#ededed] bg-white/[0.06] px-2.5 py-1.5 rounded">
                      指定サイズに対して動画が長いため画質が低下します。解像度（720p）またはFPS（30fps）を下げるのがおすすめです。
                    </div>
                  )}
                </div>
              )}

              {/* Active Progress Bar */}
              {exportRunning && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex justify-between font-num text-[11px] text-[#ededed]">
                    <span>GPU書き出し処理中…</span>
                    <span>{Math.round(exportProgress * 100)}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-[#1a1a1a] overflow-hidden">
                    <div
                      style={{ width: `${Math.round(exportProgress * 100)}%` }}
                      className="h-full bg-[#ededed] transition-all duration-100"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-between pt-2">
              <button
                type="button"
                disabled={exportRunning}
                onClick={() => {
                  setExportHeight(0);
                  setExportFps(0);
                  setExportQuality("recommended");
                }}
                className="h-9 px-3 rounded-[8px] text-xs text-[#8f8f8f] hover:text-[#ededed] disabled:opacity-35 cursor-pointer"
              >
                初期設定に戻す
              </button>

              <div className="flex items-center gap-2">
                {exportRunning ? (
                  <button
                    type="button"
                    onClick={() => void clipsCancelExport()}
                    className="h-9 px-4 rounded-[8px] bg-[#1a1a1a] hover:bg-[#242424] text-[#ededed] text-xs vt-hairline cursor-pointer"
                  >
                    キャンセル
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => setExportOpen(false)}
                      className="h-9 px-4 rounded-[8px] bg-[#161616] text-[#8f8f8f] hover:text-[#ededed] text-xs cursor-pointer"
                    >
                      閉じる
                    </button>
                    <button
                      type="button"
                      disabled={!exportPlan}
                      onClick={() => void startExportJob()}
                      className="h-9 px-5 rounded-[8px] bg-[#ededed] hover:bg-white text-[#0a0a0a] text-xs font-medium disabled:opacity-35 flex items-center gap-1.5 cursor-pointer"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>書き出し開始</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function renderRulerTicks(widthPx: number, pxPerSec: number) {
  const stepSec =
    pxPerSec >= 90 ? 1 : pxPerSec >= 40 ? 2 : pxPerSec >= 20 ? 5 : 10;
  const maxSec = Math.ceil(widthPx / pxPerSec);
  const nodes = [];
  for (let s = 0; s <= maxSec; s += stepSec) {
    nodes.push(
      <div
        key={s}
        style={{ left: s * pxPerSec }}
        className="absolute top-0 bottom-0 flex flex-col justify-end pointer-events-none"
      >
        <span className="text-[9px] font-num text-[#5c5c5c] pl-1 leading-none mb-1">
          {formatDuration(s)}
        </span>
        <span className="w-px h-1.5 bg-white/[0.18]" />
      </div>,
    );
  }
  return nodes;
}

function WaveformCanvas({
  peaks,
  rms,
  totalDurationHns,
  srcIn,
  srcOut,
  gain,
  widthPx,
}: {
  peaks: number[];
  rms: number[];
  totalDurationHns: number;
  srcIn: number;
  srcOut: number;
  gain: number;
  widthPx: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || peaks.length === 0 || totalDurationHns <= 0) return;
    const w = Math.max(12, Math.min(2400, widthPx));
    const h = 44;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, w, h);

    const n = peaks.length;
    const f0 = Math.max(0, Math.min(1, srcIn / totalDurationHns));
    const f1 = Math.max(f0 + 0.001, Math.min(1, srcOut / totalDurationHns));
    const midY = h * 0.58;
    const maxAmp = h * 0.42;

    for (let x = 0; x < w; x += 2) {
      const frac = f0 + ((x / w) * (f1 - f0));
      const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
      const pk = Math.min(1, (peaks[idx] ?? 0) * gain);
      const rm = Math.min(1, (rms[idx] ?? 0) * gain);

      const pkH = Math.max(1, pk * maxAmp);
      ctx.fillStyle = "rgba(237, 237, 237, 0.22)";
      ctx.fillRect(x, midY - pkH, 1.5, pkH * 2);

      const rmH = Math.max(0.8, rm * maxAmp);
      ctx.fillStyle = "rgba(237, 237, 237, 0.52)";
      ctx.fillRect(x, midY - rmH, 1.5, rmH * 2);
    }
  }, [peaks, rms, totalDurationHns, srcIn, srcOut, gain, widthPx]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
    />
  );
}
