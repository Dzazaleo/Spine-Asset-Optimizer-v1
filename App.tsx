
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { DropZone } from './components/DropZone';
import { AnimationCard } from './components/AnimationCard';
import { OptimizationModal } from './components/OptimizationModal';
import { PercentageOverrideModal } from './components/PercentageOverrideModal';
import { GlobalStatsSummary } from './components/GlobalStatsSummary';
import { UnusedAssetsCard } from './components/UnusedAssetsCard';
import { AtlasPreviewModal } from './components/AtlasPreviewModal';
import { AnalysisProgressModal } from './components/AnalysisProgressModal';
import { TrackConfigModal } from './components/TrackConfigModal';
import { SpineJson, AnalysisReport, FileAsset, OptimizationTask, OptimizerConfig, AtlasAssetMap, TrackItem, SkinDoc, EventDoc, BoneDoc } from './types';
import { analyzeSpineData, extractCanonicalDimensions } from './utils/spineParser';
import { calculateOptimizationTargets, generateOptimizedZip } from './utils/optimizer';
import { parseAtlas } from './utils/atlasParser';
import { unpackTextures, UnpackedAsset } from './utils/atlasUnpacker';
import { Activity, Layers, Search, X, Zap, CheckSquare, RotateCcw, Download, Upload, Film, AlertTriangle } from 'lucide-react';

type SortKey = 'path' | 'originalSize' | 'maxRenderSize' | 'sourceAnimation';

export default function App() {
  // Spine Skeleton State
  const [spineData, setSpineData] = useState<SpineJson | null>(null);
  const [spineFile, setSpineFile] = useState<File | null>(null);
  
  // Atlas State
  const [atlasFile, setAtlasFile] = useState<File | null>(null);
  const [atlasMetadata, setAtlasMetadata] = useState<AtlasAssetMap>(new Map());
  
  // Image Assets State
  // texturePages: Flat map of filename -> File (for Atlas reconstruction)
  const [texturePages, setTexturePages] = useState<Map<string, File>>(new Map());
  
  // inMemoryImages: Unpacked assets from Atlas
  const [inMemoryImages, setInMemoryImages] = useState<Map<string, UnpackedAsset>>(new Map());
  
  // Asset Resolution Overrides (Path -> Percentage)
  const [assetOverrides, setAssetOverrides] = useState<Map<string, number>>(new Map());

  // Local Scale Overrides for missing keyframes (AnimationName|LookupKey -> boolean)
  const [localScaleOverrides, setLocalScaleOverrides] = useState<Set<string>>(new Set());

  // Multi-Select State
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [lastSelectedKey, setLastSelectedKey] = useState<string | null>(null);

  // Analysis Report
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  
  // Global Collapse/Expand State
  const [allExpanded, setAllExpanded] = useState(false);

  // Sorting State for Global Stats
  const [sortConfig, setSortConfig] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ 
    key: 'path', 
    direction: 'asc' 
  });

  // Deep Link State
  const [expandTrigger, setExpandTrigger] = useState<{name: string, ts: number} | null>(null);
  const animationRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // Optimization Modal State
  const [isOptModalOpen, setIsOptModalOpen] = useState(false);
  const [optTasks, setOptTasks] = useState<OptimizationTask[]>([]);
  const [optimizationBuffer, setOptimizationBuffer] = useState(1);
  const [isProcessingOpt, setIsProcessingOpt] = useState(false);
  const [optProgress, setOptProgress] = useState({ current: 0, total: 0 });

  // Override Modal State
  const [overrideModalOpen, setOverrideModalOpen] = useState(false);
  const [selectedAssetForOverride, setSelectedAssetForOverride] = useState<{lookupKey: string, path: string, overridePercentage?: number} | null>(null);

  // Atlas Preview State
  const [isAtlasModalOpen, setIsAtlasModalOpen] = useState(false);
  const [atlasTasks, setAtlasTasks] = useState<OptimizationTask[]>([]);

  // Documentation / Track Builder State
  const [isTrackModalOpen, setIsTrackModalOpen] = useState(false);
  const [trackList, setTrackList] = useState<TrackItem[]>(() => 
    Array.from({ length: 5 }, (_, i) => ({
      id: Math.random().toString(36).substring(2, 9),
      trackIndex: i,
      animations: []
    }))
  );
  
  // New Documentation State
  const [skinDocs, setSkinDocs] = useState<SkinDoc[]>([]);
  const [eventDocs, setEventDocs] = useState<EventDoc[]>([]);
  const [boneDocs, setBoneDocs] = useState<BoneDoc[]>([]);
  const [generalNotes, setGeneralNotes] = useState("");

  // Initial Analysis Loading State
  const [isAnalysisLoading, setIsAnalysisLoading] = useState(false);
  const [analysisProgress, setAnalysisProgress] = useState({ current: 0, total: 100 });
  const [analysisStatus, setAnalysisStatus] = useState("");

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Debounce Search Term
  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedSearchTerm(searchTerm);
    }, 200);

    return () => {
      clearTimeout(handler);
    };
  }, [searchTerm]);

  const handleFilesLoaded = async (assets: FileAsset[]) => {
    setIsAnalysisLoading(true);
    setAnalysisStatus("Initializing...");
    setAnalysisProgress({ current: 0, total: 100 });

    try {
      // 1. Identify dropped content
      const newJsonAsset = assets.find(a => a.file.name.toLowerCase().endsWith('.json'));
      const newAtlasAsset = assets.find(a => a.file.name.toLowerCase().endsWith('.atlas') || a.file.name.toLowerCase().endsWith('.atlas.txt'));
      const newImageAssets = assets.filter(a => a.file.type.startsWith('image/'));

      // 2. Initialize working state from current state (default)
      let currentSpineData = spineData;
      let currentSpineFile = spineFile;
      let currentAtlasFile = atlasFile;
      let currentAtlasMetadata = atlasMetadata;
      // Use existing maps as base unless overwritten below
      let currentTexturePages = new Map<string, File>(texturePages);
      let currentInMemoryImages = new Map<string, UnpackedAsset>(inMemoryImages);
      
      let currentAssetOverrides = assetOverrides;
      let currentLocalOverrides = localScaleOverrides;

      // 3. Conditional Overwrites (Fixing Accumulation Issue)

      // JSON Overwrite
      if (newJsonAsset) {
          currentSpineFile = newJsonAsset.file;
          const text = await newJsonAsset.file.text();
          try {
             currentSpineData = JSON.parse(text);
             // Reset configuration dependent on skeleton structure
             currentAssetOverrides = new Map();
             currentLocalOverrides = new Set();
             setSelectedKeys(new Set());
             setLastSelectedKey(null);
          } catch (e) {
             console.error("JSON Parse Error", e);
             alert(`Failed to parse JSON: ${newJsonAsset.file.name}`);
             currentSpineData = null;
          }
      }

      // Atlas Overwrite
      if (newAtlasAsset) {
          currentAtlasFile = newAtlasAsset.file;
          const text = await newAtlasAsset.file.text();
          currentAtlasMetadata = parseAtlas(text);
      }

      // Images Overwrite
      if (newImageAssets.length > 0) {
          // Explicitly clear previous images to avoid accumulation
          currentInMemoryImages = new Map();
          currentTexturePages = new Map();
          
          // Register new texture pages
          newImageAssets.forEach(asset => {
              currentTexturePages.set(asset.file.name, asset.file);
          });
      }
      
      // Stage 2: Loading and Unpacking
      setAnalysisStatus("Stage 2: Processing Images...");
      setAnalysisProgress({ current: 20, total: 100 });
      
      // Extract Canonical Dimensions from JSON (if available)
      const canonicalDims = currentSpineData ? extractCanonicalDimensions(currentSpineData) : new Map();

      // 2a. Process New Raw Images
      // Note: We only process newImageAssets here. If no new images were dropped, currentInMemoryImages remains as is.
      if (newImageAssets.length > 0) {
          for (const asset of newImageAssets) {
             // Normalize path to forward slashes for consistent lookups
             const normalizedPath = asset.path.replace(/\\/g, '/');
             const lookupKey = normalizedPath.toLowerCase();
             
             // --- CANONICAL DIMENSION LOOKUP STRATEGY ---
             let noExt = lookupKey;
             const lastDotIndex = lookupKey.lastIndexOf('.');
             if (lastDotIndex !== -1) {
                 noExt = lookupKey.substring(0, lastDotIndex);
             }

             let canonical = canonicalDims.get(noExt);
             if (!canonical && noExt.startsWith('images/')) {
                 canonical = canonicalDims.get(noExt.substring(7)); // Remove 'images/'
             }
             if (!canonical) {
                 const firstSlash = noExt.indexOf('/');
                 if (firstSlash !== -1) {
                     const strippedPrefix = noExt.substring(firstSlash + 1);
                     canonical = canonicalDims.get(strippedPrefix);
                 }
             }
             
             const physicalW = asset.width || 0;
             const physicalH = asset.height || 0;
             
             let finalW = physicalW;
             let finalH = physicalH;
             
             if (canonical) {
                 finalW = canonical.width;
                 finalH = canonical.height;
             }

             // Direct Add to Memory
             currentInMemoryImages.set(normalizedPath, {
                 name: normalizedPath,
                 blob: asset.file,
                 width: finalW,   // LOGICAL Size
                 height: finalH,  // LOGICAL Size
                 sourceWidth: physicalW,   // PHYSICAL Size
                 sourceHeight: physicalH,  // PHYSICAL Size
                 url: URL.createObjectURL(asset.file)
             });
          }
      }

      // 2b. Process Atlas (if available)
      if (currentAtlasMetadata.size > 0 && currentTexturePages.size > 0) {
          const unpacked = await unpackTextures(currentTexturePages, currentAtlasMetadata, (curr, total) => {
             const percentage = 20 + Math.floor((curr / total) * 60);
             setAnalysisProgress({ current: percentage, total: 100 });
             setAnalysisStatus(`Stage 2: Unpacking Atlas Regions (${curr} of ${total})...`);
          });
          
          // Merge unpacked textures into the main map
          unpacked.forEach((v, k) => currentInMemoryImages.set(k, v));
      }

      // 2c. Cleanup Atlas Pages
      // Identify texture pages defined in the atlas and remove them from inMemoryImages 
      // so they don't appear as "Unused Assets".
      if (currentAtlasMetadata.size > 0) {
          const atlasPages = new Set<string>();
          for (const region of currentAtlasMetadata.values()) {
              atlasPages.add(region.pageName);
          }
          
          const keysToCheck = Array.from(currentInMemoryImages.keys());
          for (const key of keysToCheck) {
              const asset = currentInMemoryImages.get(key);
              if (!asset) continue;

              // If this asset corresponds to a raw file (File object) and matches an atlas page name, remove it.
              // Note: Unpacked regions have 'blob' as Blob, while raw drops have 'blob' as File.
              if (asset.blob instanceof File && atlasPages.has(asset.blob.name)) {
                  currentInMemoryImages.delete(key);
              }
          }
      }

      // Stage 3: Calculation & Analysis
      setAnalysisStatus("Stage 3: Calculating Global Maximum Render Sizes...");
      setAnalysisProgress({ current: 85, total: 100 });

      // Prepare processed assets map for analysis
      // UPDATED: Include source dimensions for mismatch detection
      const processedMap = new Map<string, { width: number, height: number, sourceWidth?: number, sourceHeight?: number, file: File, originalPath: string }>();
      currentInMemoryImages.forEach((asset: UnpackedAsset) => {
          const file = new File([asset.blob], `${asset.name}.png`, { type: 'image/png' });
          const normalizedKey = asset.name.replace(/\\/g, '/').toLowerCase();
          processedMap.set(normalizedKey, {
              width: asset.width,
              height: asset.height,
              sourceWidth: asset.sourceWidth,
              sourceHeight: asset.sourceHeight,
              file: file,
              originalPath: asset.name
          });
      });

      // Run analysis synchronously if we have data
      let newReport = report;
      if (currentSpineData) {
         // Note: We use empty maps for overrides initially if this is a fresh load, 
         // or keep existing overrides if just updating files.
         newReport = analyzeSpineData(currentSpineData, processedMap, currentAssetOverrides, currentLocalOverrides);
         
         // Pre-populate Documentation States if JSON changed
         if (newJsonAsset) {
             setSkinDocs(newReport.skins.map(name => ({ name, description: '' })));
             setEventDocs(newReport.events.map(name => ({ name, description: '' })));
             setBoneDocs(newReport.controlBones.map(name => ({ name, description: '' })));
         } else {
             // Reconcile: Add new items, keep existing descriptions
             if (skinDocs.length === 0) {
                  setSkinDocs(newReport.skins.map(name => ({ name, description: '' })));
             } else {
                 setSkinDocs(prev => {
                    const existing = new Map(prev.map(d => [d.name, d.description]));
                    return newReport!.skins.map(name => ({
                        name,
                        description: existing.get(name) || ''
                    }));
                 });
             }
             
             if (eventDocs.length === 0) {
                setEventDocs(newReport.events.map(name => ({ name, description: '' })));
             } else {
                 setEventDocs(prev => {
                    const existing = new Map(prev.map(d => [d.name, d.description]));
                    return newReport!.events.map(name => ({
                        name,
                        description: existing.get(name) || ''
                    }));
                 });
             }
             
             if (boneDocs.length === 0) {
                setBoneDocs(newReport.controlBones.map(name => ({ name, description: '' })));
             } else {
                 setBoneDocs(prev => {
                    const existing = new Map(prev.map(d => [d.name, d.description]));
                    return newReport!.controlBones.map(name => ({
                        name,
                        description: existing.get(name) || ''
                    }));
                 });
             }
         }
      }

      // Stage 4: Finalizing
      setAnalysisStatus("Stage 4: Finalizing Report...");
      setAnalysisProgress({ current: 95, total: 100 });

      // Artificial delay for UX smoothing
      await new Promise(resolve => setTimeout(resolve, 600));

      // Batch state updates
      setSpineFile(currentSpineFile);
      setSpineData(currentSpineData);
      setAtlasFile(currentAtlasFile);
      setAtlasMetadata(currentAtlasMetadata);
      setTexturePages(currentTexturePages);
      setInMemoryImages(currentInMemoryImages);
      setReport(newReport);
      
      setAnalysisProgress({ current: 100, total: 100 });
      
    } catch (error) {
       console.error("Processing failed", error);
       alert("An error occurred during file processing.");
    } finally {
       setIsAnalysisLoading(false);
    }
  };

  const handleClearAssets = () => {
    // Reset Data
    setSpineData(null);
    setSpineFile(null);
    setAtlasFile(null);
    setAtlasMetadata(new Map());
    setTexturePages(new Map());
    setInMemoryImages(new Map());
    
    // Reset Overrides & Selection
    setAssetOverrides(new Map());
    setLocalScaleOverrides(new Set());
    setSelectedKeys(new Set());
    setLastSelectedKey(null);
    
    // Reset Report & UI
    setReport(null);
    setSearchTerm("");
    setDebouncedSearchTerm("");
    
    // Reset Docs
    setTrackList(Array.from({ length: 5 }, (_, i) => ({
      id: Math.random().toString(36).substring(2, 9),
      trackIndex: i,
      animations: []
    })));
    setSkinDocs([]);
    setEventDocs([]);
    setBoneDocs([]);
    setGeneralNotes("");

    // Reset Config
    setOptimizationBuffer(1);
    
    // Clear File Input (if used via button)
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // Re-run analysis when overrides change (using existing State)
  const processedAssets = useMemo(() => {
    // UPDATED: Include source dimensions in memoized map
    const map = new Map<string, { width: number, height: number, sourceWidth?: number, sourceHeight?: number, file: File, originalPath: string }>();
    inMemoryImages.forEach((asset: UnpackedAsset) => {
        const file = new File([asset.blob], `${asset.name}.png`, { type: 'image/png' });
        const normalizedKey = asset.name.replace(/\\/g, '/').toLowerCase();
        map.set(normalizedKey, {
            width: asset.width,
            height: asset.height,
            sourceWidth: asset.sourceWidth,
            sourceHeight: asset.sourceHeight,
            file: file,
            originalPath: asset.name
        });
    });
    return map;
  }, [inMemoryImages]);

  useEffect(() => {
    // Only run if we are NOT currently loading (to avoid double work during initial load)
    // and we have data.
    if (!isAnalysisLoading && spineData) {
      const analysis = analyzeSpineData(spineData, processedAssets, assetOverrides, localScaleOverrides);
      setReport(analysis);
    }
  }, [spineData, processedAssets, assetOverrides, localScaleOverrides, isAnalysisLoading]);


  const handleOpenOptimization = () => {
    if (!report) return;
    const tasks = calculateOptimizationTargets(report.animations, processedAssets, optimizationBuffer);
    setOptTasks(tasks);
    setIsOptModalOpen(true);
  };

  const handleAtlasPreviewFromModal = () => {
    setAtlasTasks(optTasks);
    setIsAtlasModalOpen(true);
  };

  const handleBufferChange = (newBuffer: number) => {
    if (!report) return;
    setOptimizationBuffer(newBuffer);
    const tasks = calculateOptimizationTargets(report.animations, processedAssets, newBuffer);
    setOptTasks(tasks);
  };

  const handleRunOptimization = async () => {
    setIsProcessingOpt(true);
    setOptProgress({ current: 0, total: optTasks.length });
    try {
      const blob = await generateOptimizedZip(optTasks, (current, total) => {
        setOptProgress({ current, total });
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = "images_resized.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setTimeout(() => {
        setIsProcessingOpt(false);
        setIsOptModalOpen(false);
      }, 1000);
    } catch (error) {
      console.error("Optimization failed", error);
      alert("Failed to generate optimized images.");
      setIsProcessingOpt(false);
    }
  };

  const handleSelectionAction = (key: string, visibleKeys: string[], modifiers: { shiftKey: boolean, ctrlKey: boolean, metaKey: boolean }) => {
    // Universal Selection Logic
    const newSelected = new Set(selectedKeys);
    
    if (modifiers.shiftKey && lastSelectedKey) {
        // Range Selection
        const startIdx = visibleKeys.indexOf(lastSelectedKey);
        const endIdx = visibleKeys.indexOf(key);
        
        if (startIdx !== -1 && endIdx !== -1) {
            const low = Math.min(startIdx, endIdx);
            const high = Math.max(startIdx, endIdx);

            // Add range to selection (additive behavior usually expected in web/OS for list views)
            if (!modifiers.ctrlKey && !modifiers.metaKey) {
                // If Ctrl/Cmd not held, we might consider clearing previous disjoint selections.
                // However, standard browser list behavior often keeps it simple. 
                // We'll stick to additive for user friendliness unless specifically asked to clear.
            }
            
            for (let i = low; i <= high; i++) {
                newSelected.add(visibleKeys[i]);
            }
        } else {
             // Fallback: Anchor not in current view
             newSelected.add(key);
             setLastSelectedKey(key);
        }
    } else if (modifiers.ctrlKey || modifiers.metaKey) {
        // Toggle
        if (newSelected.has(key)) {
            newSelected.delete(key);
        } else {
            newSelected.add(key);
        }
        setLastSelectedKey(key);
    } else {
        // Standard (Exclusive)
        newSelected.clear();
        newSelected.add(key);
        setLastSelectedKey(key);
    }

    setSelectedKeys(newSelected);
  };

  const handleClearSelection = () => {
    setSelectedKeys(new Set());
    setLastSelectedKey(null);
  };

  const handleResetAll = () => {
    setAssetOverrides(new Map());
    setLocalScaleOverrides(new Set());
    setSelectedKeys(new Set());
    setLastSelectedKey(null);
  };

  const handleSaveConfig = () => {
    const config: OptimizerConfig = {
      version: 1, // Changed from 2 to 1
      timestamp: new Date().toISOString(),
      overrides: Array.from(assetOverrides.entries()),
      localOverrides: Array.from(localScaleOverrides),
      selections: Array.from(selectedKeys),
      // New Documentation Persistence
      trackList,
      skinDocs,
      eventDocs,
      boneDocs,
      generalNotes,
      safetyBuffer: optimizationBuffer
    };
    
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;

    const dateStr = new Date().toISOString().slice(0, 10);
    let downloadName = `spine-optimizer-config-${dateStr}.json`;
    
    if (spineFile) {
      const cleanName = spineFile.name.replace(/\.json$/i, "");
      downloadName = `spine-optimizer-config-${cleanName}-${dateStr}.json`;
    }

    a.download = downloadName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleLoadConfig = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const json = JSON.parse(ev.target?.result as string) as OptimizerConfig;
        
        // Basic validation
        if (json.overrides && Array.isArray(json.overrides)) {
          setAssetOverrides(new Map(json.overrides));
        }
        if (json.localOverrides && Array.isArray(json.localOverrides)) {
          setLocalScaleOverrides(new Set(json.localOverrides));
        }
        if (json.selections && Array.isArray(json.selections)) {
          setSelectedKeys(new Set(json.selections));
        }

        // New Documentation Validation & Loading
        if (json.trackList && Array.isArray(json.trackList)) {
            setTrackList(json.trackList);
        }
        if (json.skinDocs && Array.isArray(json.skinDocs)) {
            setSkinDocs(json.skinDocs);
        }
        if (json.eventDocs && Array.isArray(json.eventDocs)) {
            setEventDocs(json.eventDocs);
        }
        if (json.boneDocs && Array.isArray(json.boneDocs)) {
            setBoneDocs(json.boneDocs);
        }
        if (typeof json.generalNotes === 'string') {
            setGeneralNotes(json.generalNotes);
        }
        if (typeof json.safetyBuffer === 'number') {
            setOptimizationBuffer(json.safetyBuffer);
        }
        
        // Reset file input
        e.target.value = ''; 
        alert("Configuration loaded successfully.");
      } catch (err) {
        console.error("Failed to parse config", err);
        alert("Invalid configuration file.");
      }
    };
    reader.readAsText(file);
  };

  const handleOverrideClick = (asset: {lookupKey: string, path: string, overridePercentage?: number}) => {
    setSelectedAssetForOverride(asset);
    setOverrideModalOpen(true);
  };

  const handleLocalOverride = (animationName: string, lookupKey: string) => {
    setLocalScaleOverrides(prev => {
      // EXPLICIT TYPE FIX: Type the Set constructor
      const next = new Set<string>(prev);
      const key = `${animationName}|${lookupKey}`;
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleToggleExpandAll = () => {
    setAllExpanded(prev => !prev);
  };

  const handleSort = (key: SortKey) => {
    setSortConfig(current => {
      if (current.key === key) {
        return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
      }
      if (key === 'originalSize' || key === 'maxRenderSize') {
          return { key, direction: 'desc' };
      }
      return { key, direction: 'asc' };
    });
  };

  const handleAnimationDeepLink = (animName: string) => {
    setExpandTrigger({ name: animName, ts: Date.now() });
    
    // Give time for state updates if necessary, though refs are usually stable.
    setTimeout(() => {
        const el = animationRefs.current.get(animName);
        if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
    }, 50);
  };

  const applyOverride = (percentage: number) => {
    if (!selectedAssetForOverride) return;
    const targets = new Set<string>();
    
    if (selectedKeys.has(selectedAssetForOverride.lookupKey) && selectedKeys.size > 0) {
      selectedKeys.forEach(k => targets.add(k));
    } else {
      targets.add(selectedAssetForOverride.lookupKey);
    }

    // EXPLICIT TYPE FIX: Type the Map constructor
    const newOverrides = new Map<string, number>(assetOverrides);
    targets.forEach(key => {
       if (percentage > 0) {
        newOverrides.set(key, percentage);
      } else {
        newOverrides.delete(key);
      }
    });

    setAssetOverrides(newOverrides);
  };

  const filteredResults = useMemo(() => {
    if (!report) return [];
    const results = report.animations;
    
    if (!debouncedSearchTerm.trim()) return results;
    const term = debouncedSearchTerm.toLowerCase();
    
    // Allow partial matching for special keywords
    const isOverrideSearch = term.length >= 2 && 'override'.startsWith(term);
    const isSkinSearch = term.length >= 2 && 'skin'.startsWith(term);
    
    return results.filter(result => {
      if (result.animationName.toLowerCase().includes(term)) return true;
      
      const assetMatch = (img: any) => {
        const textMatch = img.path.toLowerCase().includes(term) || img.bonePath.toLowerCase().includes(term);
        const overrideMatch = isOverrideSearch && (!!img.isLocalScaleOverridden || !!img.isOverridden);
        const skinMatch = isSkinSearch && !!img.showSkinLabel;
        return textMatch || overrideMatch || skinMatch;
      };

      const hasMatchingFound = result.foundImages.some(assetMatch);
      if (hasMatchingFound) return true;
      
      const hasMatchingMissing = result.missingImages.some(assetMatch);
      if (hasMatchingMissing) return true;
      
      return false;
    });
  }, [report, debouncedSearchTerm]);

  const filteredGlobalStats = useMemo(() => {
    if (!report) return [];
    let stats = report.globalStats;
    
    if (debouncedSearchTerm.trim()) {
      const term = debouncedSearchTerm.toLowerCase();
      // Allow partial matching for special keywords
      const isOverrideSearch = term.length >= 2 && 'override'.startsWith(term);
      const isSkinSearch = term.length >= 2 && 'skin'.startsWith(term);
      
      stats = stats.filter(stat => {
        const textMatch = stat.path.toLowerCase().includes(term) || stat.sourceAnimation.toLowerCase().includes(term);
        const overrideMatch = isOverrideSearch && stat.isOverridden;
        const skinMatch = isSkinSearch && (!!stat.skinName && stat.skinName !== 'default');

        return textMatch || overrideMatch || skinMatch;
      });
    }

    return [...stats].sort((a, b) => {
      let res = 0;
      switch (sortConfig.key) {
          case 'path':
              res = a.path.localeCompare(b.path);
              break;
          case 'sourceAnimation':
              res = a.sourceAnimation.localeCompare(b.sourceAnimation);
              break;
          case 'originalSize':
              res = (a.originalWidth * a.originalHeight) - (b.originalWidth * b.originalHeight);
              break;
          case 'maxRenderSize':
              res = (a.maxRenderWidth * a.maxRenderHeight) - (b.maxRenderWidth * b.maxRenderHeight);
              break;
          default:
              res = 0;
      }
      return sortConfig.direction === 'asc' ? res : -res;
    });
  }, [report, debouncedSearchTerm, sortConfig]);

  const batchCount = selectedAssetForOverride && selectedKeys.has(selectedAssetForOverride.lookupKey) 
    ? selectedKeys.size 
    : 0;

  const hasUserChanges = assetOverrides.size > 0 || localScaleOverrides.size > 0 || selectedKeys.size > 0;

  // We use processedAssets.size as the count of images actually ready for analysis (unpacked from atlas)
  const activeImageCount = processedAssets.size;

  return (
    <div className="min-h-screen p-6 text-gray-100 bg-gray-900 md:p-12">
      <header className="max-w-5xl mx-auto mb-12 text-center">
        <h1 className="mb-3 text-4xl font-bold tracking-tight text-white md:text-5xl">
          Spine Asset <span className="text-spine-accent">Optimizer</span> <span className="text-2xl opacity-50 font-mono">v1.0</span>
        </h1>
        <p className="text-lg text-gray-400">
          Drop your Spine files to optimize assets, verify resolutions, and generate structured documentation for development teams.
        </p>
      </header>

      <main className="max-w-5xl mx-auto space-y-8">
        {/* Consolidated Drop Zone */}
        <DropZone 
          onFilesLoaded={handleFilesLoaded}
          onClear={handleClearAssets}
          stats={{
            json: spineFile?.name,
            atlas: atlasFile?.name,
            images: activeImageCount 
          }}
        />

        {report && (
          <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
            
            {report.isCanonicalDataMissing && (
              <div className="mb-6 p-4 border border-orange-500/50 bg-orange-900/20 rounded-lg flex items-start gap-4 animate-in fade-in slide-in-from-top-2">
                <AlertTriangle className="text-orange-500 shrink-0 mt-0.5" size={24} />
                <div>
                  <h3 className="text-orange-200 font-bold mb-1">WARNING: Optimization Data Incomplete</h3>
                  <p className="text-sm text-orange-300/80 leading-relaxed">
                    The loaded <span className="font-mono text-orange-200 bg-orange-950/50 px-1 rounded">{spineFile?.name}</span> appears to be missing original size data (width/height) for some assets. 
                    This is usually caused by unchecking the <strong className="text-orange-200">Nonessential data</strong> box during the Spine export process. 
                    Calculations may be incorrect. Please re-export your Spine data with this option enabled.
                  </p>
                </div>
              </div>
            )}

            {/* NEW TOOLBAR START */}
            <div className="flex flex-col gap-6 pb-6 border-b border-gray-800">
              
              {/* Row 1: Title & Stats */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Activity className="text-spine-accent" />
                  <h2 className="text-xl font-semibold">Animation Breakdown</h2>
                  <div className="flex items-center gap-2 px-3 py-1 ml-2 text-xs font-medium text-gray-400 rounded-full bg-gray-800/50">
                    <Layers size={14} />
                    <span>
                      {filteredResults.length !== report.animations.length 
                        ? `${filteredResults.length} of ${report.animations.length} Animations`
                        : `${report.animations.length} Animations`}
                    </span>
                  </div>
                </div>
              </div>

              {/* Row 2: Control Bar */}
              <div className="flex flex-col lg:flex-row items-center justify-between gap-4">
                 
                 {/* LEFT: Configuration Group */}
                 <div className="flex items-center gap-3 w-full lg:w-auto justify-center lg:justify-start">
                    {/* Save/Load Group */}
                    <div className="flex items-center bg-gray-800 p-1 rounded-lg border border-gray-700 shadow-sm">
                       <button
                           type="button"
                           onClick={handleSaveConfig}
                           className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors"
                           title="Save Configuration"
                       >
                           <Download size={14} />
                           <span className="hidden sm:inline">Save</span>
                       </button>
                       <div className="w-px h-4 bg-gray-700 mx-1"></div>
                       <button
                           type="button"
                           onClick={() => fileInputRef.current?.click()}
                           className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-gray-300 hover:text-white hover:bg-gray-700 rounded transition-colors"
                           title="Load Configuration"
                       >
                           <Upload size={14} />
                           <span className="hidden sm:inline">Load</span>
                       </button>
                       <input 
                            ref={fileInputRef}
                            type="file" 
                            accept=".json" 
                            className="hidden" 
                            onChange={handleLoadConfig}
                       />
                    </div>

                    {/* Reset/Clear Group */}
                    {(hasUserChanges || selectedKeys.size > 0) && (
                        <div className="flex items-center gap-2 animate-in fade-in slide-in-from-left-2 duration-300">
                           <div className="w-px h-8 bg-gray-800 hidden lg:block mx-1"></div>
                           {hasUserChanges && (
                               <button 
                                   type="button"
                                   onClick={handleResetAll}
                                   className="p-2 text-orange-400 bg-orange-950/30 border border-orange-900/50 rounded-lg hover:bg-orange-900/50 hover:text-orange-200 transition-colors"
                                   title="Reset Changes"
                               >
                                   <RotateCcw size={16} />
                               </button>
                           )}
                           {selectedKeys.size > 0 && (
                               <button 
                                   type="button"
                                   onClick={handleClearSelection}
                                   className="flex items-center gap-2 px-3 py-2 text-xs font-bold text-gray-300 bg-gray-800 border border-gray-700 rounded-lg hover:bg-gray-700 transition-colors"
                               >
                                   <CheckSquare size={14} className="text-spine-accent" />
                                   <span>Clear ({selectedKeys.size})</span>
                               </button>
                           )}
                        </div>
                    )}
                 </div>

                 {/* CENTER: Primary Actions */}
                 <div className="flex items-center gap-4 order-first lg:order-none w-full lg:w-auto justify-center">
                    <button
                        type="button"
                        onClick={() => setIsTrackModalOpen(true)}
                        className="flex items-center gap-2 px-5 py-2.5 text-sm font-bold text-gray-200 bg-gray-800 border border-gray-600 rounded-xl hover:bg-gray-700 hover:text-white hover:border-gray-500 transition-all shadow-sm group"
                    >
                        <Film size={18} className="text-purple-400 group-hover:text-purple-300" />
                        <span>Documentation</span>
                    </button>

                    {report.animations.length > 0 && activeImageCount > 0 && (
                        <button
                            type="button"
                            onClick={handleOpenOptimization}
                            className="flex items-center gap-2 px-6 py-2.5 text-sm font-bold text-white transition-all rounded-xl bg-blue-600 hover:bg-blue-500 shadow-lg shadow-blue-900/20 hover:shadow-blue-900/40 hover:-translate-y-0.5 active:translate-y-0"
                        >
                            <Zap size={18} className="fill-current" />
                            <span>Optimize Assets</span>
                        </button>
                    )}
                 </div>

                 {/* RIGHT: Search */}
                 <div className="relative w-full lg:w-64 group">
                    <div className="absolute inset-y-0 left-0 flex items-center pl-3 pointer-events-none text-gray-500 group-focus-within:text-spine-accent transition-colors">
                        <Search size={16} />
                    </div>
                    <input
                        type="text"
                        placeholder="Search assets..."
                        value={searchTerm}
                        onChange={(e) => setSearchTerm(e.target.value)}
                        className="w-full py-2 pl-10 pr-8 text-sm text-gray-200 transition-all border border-gray-700 rounded-lg bg-gray-800/50 focus:outline-none focus:ring-1 focus:ring-spine-accent/50 focus:border-spine-accent/50 placeholder:text-gray-600 focus:bg-gray-800"
                    />
                    {searchTerm && (
                        <button 
                        onClick={() => setSearchTerm('')}
                        className="absolute inset-y-0 right-0 flex items-center pr-2 text-gray-500 hover:text-gray-300"
                        >
                        <X size={14} />
                        </button>
                    )}
                 </div>

              </div>
            </div>
            {/* NEW TOOLBAR END */}

            <GlobalStatsSummary 
              stats={filteredGlobalStats} 
              selectedKeys={selectedKeys}
              onMultiSelect={handleSelectionAction}
              onOverrideClick={handleOverrideClick}
              sortConfig={sortConfig}
              onSort={handleSort}
              onAnimationClick={handleAnimationDeepLink}
            />

            {report.unusedAssets.length > 0 && (
              <UnusedAssetsCard assets={report.unusedAssets} />
            )}

            <div className="space-y-4" onDoubleClick={handleToggleExpandAll} title="Double-click to toggle expand/collapse all">
              {filteredResults.length === 0 ? (
                <div className="p-12 text-center border border-dashed rounded-lg border-gray-800 bg-spine-card/20">
                  <p className="text-gray-500">
                    {searchTerm 
                      ? `No animations or assets found matching "${searchTerm}"` 
                      : "No animations found in the provided JSON."}
                  </p>
                  {searchTerm && (
                    <button 
                      onClick={() => setSearchTerm('')}
                      className="mt-4 text-sm text-spine-accent hover:underline"
                    >
                      Clear search
                    </button>
                  )}
                </div>
              ) : (
                filteredResults.map((result, idx) => (
                  <AnimationCard 
                    key={`${result.animationName}-${idx}`} 
                    result={result} 
                    searchTerm={debouncedSearchTerm}
                    onOverrideClick={handleOverrideClick}
                    selectedKeys={selectedKeys}
                    onMultiSelect={handleSelectionAction}
                    onLocalOverride={handleLocalOverride}
                    globalExpanded={allExpanded}
                    expandTrigger={expandTrigger}
                    setRef={(el) => {
                       if (el) animationRefs.current.set(result.animationName, el);
                       else animationRefs.current.delete(result.animationName);
                    }}
                  />
                ))
              )}
            </div>
          </div>
        )}

        <footer className="mt-12 text-center text-sm text-gray-600">
           {/* Footer content can go here if needed */}
        </footer>
      </main>

      <AnalysisProgressModal 
        isOpen={isAnalysisLoading} 
        statusText={analysisStatus} 
        progress={analysisProgress} 
      />

      <OptimizationModal 
        isOpen={isOptModalOpen}
        onClose={() => !isProcessingOpt && setIsOptModalOpen(false)}
        onConfirm={handleRunOptimization}
        onPreview={handleAtlasPreviewFromModal}
        tasks={optTasks}
        isProcessing={isProcessingOpt}
        progress={optProgress}
        buffer={optimizationBuffer}
        onBufferChange={handleBufferChange}
      />

      <PercentageOverrideModal
        isOpen={overrideModalOpen}
        onClose={() => setOverrideModalOpen(false)}
        onConfirm={applyOverride}
        initialValue={selectedAssetForOverride?.overridePercentage}
        assetPath={selectedAssetForOverride?.path || ""}
        batchCount={batchCount}
      />

      <AtlasPreviewModal 
        isOpen={isAtlasModalOpen}
        onClose={() => setIsAtlasModalOpen(false)}
        tasks={atlasTasks}
      />

      <TrackConfigModal 
        isOpen={isTrackModalOpen}
        onClose={() => setIsTrackModalOpen(false)}
        availableAnimations={report?.animations.map(a => a.animationName).sort() || []}
        trackList={trackList}
        setTrackList={setTrackList}
        
        // Documentation Props
        skinDocs={skinDocs}
        setSkinDocs={setSkinDocs}
        eventDocs={eventDocs}
        setEventDocs={setEventDocs}
        boneDocs={boneDocs}
        setBoneDocs={setBoneDocs}
        generalNotes={generalNotes}
        setGeneralNotes={setGeneralNotes}
        
        // New Prop
        safetyBuffer={optimizationBuffer}
        
        // Metadata
        skeletonName={spineFile?.name || "Skeleton"}
        totalImages={report?.globalStats.length || 0}
        totalAnimations={report?.animations.length || 0}
      />
    </div>
  );
}