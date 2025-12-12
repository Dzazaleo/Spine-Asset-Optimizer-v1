
import { AtlasAssetMap, AtlasRegion } from '../types';

export interface UnpackedAsset {
  name: string;
  blob: Blob;
  width: number;
  height: number;
  url: string;
  sourceWidth?: number;
  sourceHeight?: number;
}

export async function unpackTextures(
  texturePages: Map<string, File>,
  atlasMetadata: AtlasAssetMap,
  onProgress?: (current: number, total: number) => void
): Promise<Map<string, UnpackedAsset>> {
  const unpacked = new Map<string, UnpackedAsset>();
  
  // Group regions by page
  const pageRegions = new Map<string, AtlasRegion[]>();
  let totalRegions = 0;

  for (const region of atlasMetadata.values()) {
    const pageName = region.pageName;
    if (!pageRegions.has(pageName)) {
      pageRegions.set(pageName, []);
    }
    pageRegions.get(pageName)!.push(region);
    totalRegions++;
  }

  let processedCount = 0;
  if (onProgress) onProgress(0, totalRegions);

  // Iterate pages
  for (const [pageName, regions] of pageRegions) {
    const file = texturePages.get(pageName);
    if (!file) {
      console.warn(`Texture page not found: ${pageName}`);
      // Even if skipped, count as processed for progress bar
      processedCount += regions.length;
      if (onProgress) onProgress(processedCount, totalRegions);
      continue;
    }

    const imgUrl = URL.createObjectURL(file);
    let img: HTMLImageElement;
    
    try {
        img = await new Promise<HTMLImageElement>((resolve, reject) => {
            const i = new Image();
            i.onload = () => resolve(i);
            i.onerror = reject;
            i.src = imgUrl;
        });
    } catch (e) {
        console.error(`Failed to load texture page: ${pageName}`, e);
        URL.revokeObjectURL(imgUrl);
        processedCount += regions.length;
        if (onProgress) onProgress(processedCount, totalRegions);
        continue;
    }

    // Process all regions in this page
    for (const region of regions) {
       const blob = await extractRegion(img, region);
       if (blob) {
         const url = URL.createObjectURL(blob);
         unpacked.set(region.name, {
           name: region.name,
           blob,
           width: region.originalWidth,
           height: region.originalHeight,
           url,
           sourceWidth: region.originalWidth, // For atlas, source IS the restored original size
           sourceHeight: region.originalHeight
         });
       }
       processedCount++;
       if (onProgress) onProgress(processedCount, totalRegions);
    }
    
    URL.revokeObjectURL(imgUrl);
  }
  
  return unpacked;
}

async function extractRegion(img: HTMLImageElement, region: AtlasRegion): Promise<Blob | null> {
  const canvas = document.createElement('canvas');
  canvas.width = region.originalWidth;
  canvas.height = region.originalHeight;
  const ctx = canvas.getContext('2d');
  
  if (!ctx) return null;

  // Calculate destination position (Spine uses bottom-left origin for offsets)
  // offsetY is distance from bottom of original image to bottom of packed image.
  // We need top-left for canvas.
  const dx = region.offsetX;
  
  // If rotated, the packed image width corresponds to the height in the original orientation
  // and packed height corresponds to width in original orientation.
  // Standard (non-rotated): packed height is region.height.
  // Rotated: packed height (vertical span in original space) is region.width.
  const packedHeightInOriginalSpace = region.rotated ? region.width : region.height;
  
  const dy = region.originalHeight - (region.offsetY + packedHeightInOriginalSpace);

  ctx.save();

  if (region.rotated) {
    // Rotation Logic: 90 degrees CW in Atlas means we rotate -90 degrees (CCW) to restore.
    // Source: region.x, region.y, region.width, region.height (The rect in the atlas)
    // Destination: dx, dy.
    
    // We translate to the bottom-left of the destination rectangle
    ctx.translate(dx, dy + region.width);
    ctx.rotate(-90 * Math.PI / 180);
    
    // Draw: 
    // The source rect is WxH in atlas.
    // After rotation, we draw it as HxW? 
    // No, we draw the source pixels into the rotated context.
    // In rotated context (X=Up, Y=Right), we draw at 0,0.
    // Width drawn is source Width (which becomes Height in final).
    // Height drawn is source Height (which becomes Width in final).
    ctx.drawImage(
        img, 
        region.x, region.y, region.width, region.height, 
        0, 0, region.width, region.height
    );
  } else {
    // Standard Draw
    ctx.drawImage(
        img, 
        region.x, region.y, region.width, region.height, 
        dx, dy, region.width, region.height
    );
  }

  ctx.restore();

  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/png');
  });
}
