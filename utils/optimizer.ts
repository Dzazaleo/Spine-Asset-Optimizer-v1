
import { AnalysisResult, OptimizationTask } from '../types';
import JSZip from 'jszip';

/**
 * Calculates which files need optimization based on analysis results.
 * Uses in-memory Blobs from the loadedImages map.
 */
export function calculateOptimizationTargets(
  results: AnalysisResult[], 
  loadedImages: Map<string, { width: number, height: number, file: File, originalPath: string }>,
  bufferPercentage: number = 0
): OptimizationTask[] {
  
  // Track global max requirements. Include override flag.
  const globalRequirements = new Map<string, { w: number, h: number, maxScale: number, overridePercentage?: number }>();

  // 1. Aggregate max requirements
  results.forEach(anim => {
    anim.foundImages.forEach(img => {
      // Use the stable lookup key provided by the parser
      const matchingKey = img.lookupKey;

      if (matchingKey && loadedImages.has(matchingKey)) {
        const current = globalRequirements.get(matchingKey) || { w: 0, h: 0, maxScale: 0 };
        const scale = Math.max(img.maxScaleX || 1, img.maxScaleY || 1);
        
        // If the result says it's overridden, we capture that.
        // Since override is global per asset, if one instance is overridden, they all are.
        const overridePercentage = img.overridePercentage;

        globalRequirements.set(matchingKey, {
          w: Math.max(current.w, img.maxRenderWidth),
          h: Math.max(current.h, img.maxRenderHeight),
          maxScale: Math.max(current.maxScale, scale),
          overridePercentage: overridePercentage // Last writer wins (should be consistent globally)
        });
      }
    });
  });

  // 2. Iterate ALL loaded images
  const tasks: OptimizationTask[] = [];

  loadedImages.forEach((original, key) => {
    const req = globalRequirements.get(key);
    
    // CRITICAL FIX: Unused Image Exclusion
    // If the image is not referenced in the analysis (no requirements), it is unused.
    // We strictly exclude it from the optimization/output package.
    if (!req) return;
    
    let targetW = original.width;
    let targetH = original.height;
    let maxScale = req.maxScale;
    let isResize = false;
    let usedOverride = req.overridePercentage;

    if (req.overridePercentage !== undefined) {
        // Priority: Override
        const overrideW = Math.ceil(req.w);
        const overrideH = Math.ceil(req.h);
        
        // Always resize if dimensions differ, even if larger (User Request: Override)
        if (overrideW !== original.width || overrideH !== original.height) {
           targetW = overrideW;
           targetH = overrideH;
           isResize = true;
        }
    } else {
        // Standard Logic with Buffer: 
        // R_req = min(Original, MaxRender * (1 + buffer))
        const baseW = Math.ceil(req.w);
        const baseH = Math.ceil(req.h);
        
        const bufferedW = Math.ceil(baseW * (1 + bufferPercentage / 100));
        const bufferedH = Math.ceil(baseH * (1 + bufferPercentage / 100));

        const calculatedW = Math.min(original.width, bufferedW);
        const calculatedH = Math.min(original.height, bufferedH);
        
        // Only mark as resize if we save significant pixels
        if (calculatedW < original.width - 2 || calculatedH < original.height - 2) {
          targetW = calculatedW;
          targetH = calculatedH;
          isResize = true;
        }
    }
    
    // Determine Output Filename
    // Use the file.name provided by App.tsx (which adds .png if missing in atlas path)
    const outputFileName = original.file.name; 

    tasks.push({
      fileName: outputFileName,
      relativePath: original.originalPath,
      originalWidth: original.width,
      originalHeight: original.height,
      targetWidth: targetW,
      targetHeight: targetH,
      blob: original.file, // original.file is a File object, which is a Blob
      maxScaleUsed: maxScale,
      isResize: isResize,
      overridePercentage: usedOverride
    });
  });

  tasks.sort((a, b) => (a.isResize === b.isResize ? 0 : a.isResize ? -1 : 1));

  return tasks;
}

export async function resizeImage(blob: Blob, width: number, height: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(blob);
    
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(width);
      canvas.height = Math.floor(height);
      const ctx = canvas.getContext('2d', { alpha: true });
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        
        canvas.toBlob((resultBlob) => {
          URL.revokeObjectURL(url);
          resolve(resultBlob);
        }, 'image/png');
      } else {
        URL.revokeObjectURL(url);
        resolve(null);
      }
    };

    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };

    img.src = url;
  });
}

export async function generateOptimizedZip(
  tasks: OptimizationTask[], 
  onProgress: (current: number, total: number) => void
): Promise<Blob> {
  const zip = new JSZip();
  // We place images in the root of the zip to match typical texture folder expectations,
  // or inside a folder. Let's use root for simplicity as users often drag contents out.
  // The previous implementation used "images_resized" folder. We can keep that or make it root.
  // Prompt asks for "correct, clean asset names (e.g. CHICKEN/BODY.png)".
  // If the fileName includes slashes, JSZip handles subfolders automatically.
  
  // Let's bundle them in a root folder "images_optimized" to keep it clean when extracting.
  const rootFolder = zip.folder("images_optimized");
  let completed = 0;

  for (const task of tasks) {
    if (!rootFolder) break;

    // Ensure extension exists for zip entry
    let zipEntryName = task.fileName;
    if (!zipEntryName.toLowerCase().endsWith('.png')) {
        zipEntryName += '.png';
    }

    if (task.isResize) {
      const resizedBlob = await resizeImage(task.blob, task.targetWidth, task.targetHeight);
      if (resizedBlob) {
        rootFolder.file(zipEntryName, resizedBlob);
      } else {
        // Fallback to original if resize fails
        rootFolder.file(zipEntryName, task.blob);
      }
    } else {
      // Direct copy of in-memory blob
      rootFolder.file(zipEntryName, task.blob);
    }
    
    completed++;
    onProgress(completed, tasks.length);
  }

  return await zip.generateAsync({ type: "blob" });
}
