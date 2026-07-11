import { FolderOpen } from 'lucide-react';
import MediaLibraryView from '../components/media/MediaLibraryView';

// Cross-project material library. Reached from the top-bar 素材库 button,
// sibling to Home. It renders the shared MediaLibraryView in 'page' mode; the
// in-project left panel renders the same view in 'panel' mode.
export default function MediaLibraryPage() {
  return (
    <div className="flex flex-col h-full w-full bg-[#1E1E1E] overflow-hidden">
      <div className="flex items-center gap-2 px-6 h-14 shrink-0 border-b border-[#2A2A2A]">
        <FolderOpen size={18} className="text-[#2EC4B6]" />
        <h1 className="text-[15px] font-medium text-[#E5E5E5]">素材库</h1>
      </div>
      <MediaLibraryView mode="page" />
    </div>
  );
}
