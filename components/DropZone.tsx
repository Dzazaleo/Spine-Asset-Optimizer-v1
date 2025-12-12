
import React, { useCallback, useState } from 'react';
import { UploadCloud, FileJson, Image as ImageIcon, CheckCircle, FileType, Trash2 } from 'lucide-react';
import { processDropItems, enrichAssetsWithDimensions } from '../utils/fileHelpers';
import { FileAsset } from '../types';
import clsx from 'clsx';

interface DropZoneProps {
  onFilesLoaded: (files: FileAsset[]) => void;
  onClear?: () => void;
  stats?: {
    json?: string;
    atlas?: string;
    images?: number;
  };
}

export const DropZone: React.FC<DropZoneProps> = ({ 
  onFilesLoaded,
  onClear,
  stats
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    if (e.dataTransfer.items) {
      const assets = await processDropItems(e.dataTransfer.items);
      onFilesLoaded(assets);
    } else if (e.dataTransfer.files) {
      let assets: FileAsset[] = Array.from(e.dataTransfer.files).map((f: File) => ({
        file: f,
        path: f.name 
      }));
      assets = await enrichAssetsWithDimensions(assets);
      onFilesLoaded(assets);
    }
  }, [onFilesLoaded]);

  const handleFileInput = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      let assets: FileAsset[] = Array.from(e.target.files).map((f: File) => ({
        file: f,
        path: (f as any).webkitRelativePath || f.name
      }));
      assets = await enrichAssetsWithDimensions(assets);
      onFilesLoaded(assets);
      // Reset input so same file can be selected again if needed after clear
      e.target.value = ''; 
    }
  };

  const hasContent = stats?.json || stats?.atlas || (stats?.images && stats.images > 0);
  
  const borderColor = isDragging 
    ? 'border-spine-accent' 
    : hasContent
      ? 'border-spine-success' 
      : 'border-gray-600';

  const bgColor = isDragging 
    ? 'bg-spine-card/80' 
    : 'bg-spine-card/40';

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={clsx(
        "relative flex flex-col items-center justify-center w-full p-12 transition-all border-2 border-dashed rounded-xl cursor-pointer hover:bg-spine-card/60 group min-h-[250px]",
        borderColor,
        bgColor
      )}
    >
      <input
        type="file"
        className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
        onChange={handleFileInput}
        accept=".json,.atlas,.png,.jpg,.jpeg,.webp"
        multiple
      />
      
      <div className="flex flex-col items-center gap-6 text-center pointer-events-none">
        {hasContent ? (
          <div className="flex gap-8">
             <div className={clsx("flex flex-col items-center gap-2", stats?.json ? "text-spine-success" : "text-gray-500")}>
                <div className={clsx("p-3 rounded-full", stats?.json ? "bg-spine-success/20" : "bg-gray-800")}>
                   {stats?.json ? <CheckCircle size={24} /> : <FileJson size={24} />}
                </div>
                <span className="text-xs font-bold uppercase">{stats?.json ? "JSON Loaded" : "No JSON"}</span>
                {stats?.json && <span className="text-[10px] max-w-[100px] truncate">{stats.json}</span>}
             </div>

             <div className={clsx("flex flex-col items-center gap-2", stats?.atlas ? "text-spine-success" : "text-gray-500")}>
                <div className={clsx("p-3 rounded-full", stats?.atlas ? "bg-spine-success/20" : "bg-gray-800")}>
                   {stats?.atlas ? <CheckCircle size={24} /> : <FileType size={24} />}
                </div>
                <span className="text-xs font-bold uppercase">{stats?.atlas ? "Atlas Loaded" : "No Atlas"}</span>
                {stats?.atlas && <span className="text-[10px] max-w-[100px] truncate">{stats.atlas}</span>}
             </div>

             <div className={clsx("flex flex-col items-center gap-2", (stats?.images || 0) > 0 ? "text-spine-success" : "text-gray-500")}>
                <div className={clsx("p-3 rounded-full", (stats?.images || 0) > 0 ? "bg-spine-success/20" : "bg-gray-800")}>
                   {stats?.images ? <CheckCircle size={24} /> : <ImageIcon size={24} />}
                </div>
                <span className="text-xs font-bold uppercase">{(stats?.images || 0) > 0 ? `${stats?.images} Images` : "No Images"}</span>
             </div>
          </div>
        ) : (
          <div className="p-6 rounded-full bg-gray-700/50 text-gray-400 group-hover:text-spine-accent group-hover:bg-spine-accent/10 transition-colors">
            <UploadCloud className="w-12 h-12" />
          </div>
        )}
        
        <div className="space-y-2">
          <p className="text-xl font-medium text-gray-200">
            {hasContent ? "Drop more files to update" : "Drop Spine files here"}
          </p>
          <p className="text-sm text-gray-400">
            Accepts <span className="text-spine-accent">.json</span> skeleton, <span className="text-spine-accent">.atlas</span>, and <span className="text-spine-accent">.png</span> texture pages, or the json skeleton with its corresponding images folder.
          </p>
        </div>
      </div>

      {/* Clear Assets Button */}
      {hasContent && onClear && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onClear();
          }}
          className="absolute bottom-4 right-4 z-20 flex items-center gap-2 px-3 py-1.5 text-xs font-bold text-red-300 bg-red-950/50 border border-red-900/50 rounded-lg hover:bg-red-900 hover:text-white hover:border-red-500 transition-all shadow-sm"
          title="Clear all assets and reset"
        >
          <Trash2 size={14} />
          Clear Assets
        </button>
      )}
    </div>
  );
};