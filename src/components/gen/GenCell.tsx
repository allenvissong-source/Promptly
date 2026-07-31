import type { JSONContent } from '@tiptap/react';
import { Trash2, Type, GripVertical } from 'lucide-react';
import type { GenImageItem } from '../../context/GenImagesContext';
import { useGenStore } from '../../context/GenStoreContext';
import ClipNoteCard from './ClipNoteCard';

interface Props {
  cellId: string;
  images: GenImageItem[];
  note: JSONContent | null;
  dragOver: boolean;
  onReorder: (from: number, to: number) => void;
  onDeleteImage: (slotId: string) => void;
  onDeleteCell: () => void;
  // Card-level up/down drag handle (hover-revealed). Wired to the parent's
  // useCardReorder start. Omitted = no card reorder handle.
  onHandlePointerDown?: (e: React.PointerEvent) => void;
}

// One 小格子 in the gen-area: the wide-image / narrow-note variant of the shared
// ClipNoteCard. Each cell is an independent GenImages scope, so @ candidates and
// chip ordinals resolve against THIS cell only (the popup pool defaults to the
// left list, i.e. no getCandidates/onPick).
export default function GenCell({
  cellId,
  images,
  note,
  dragOver,
  onReorder,
  onDeleteImage,
  onDeleteCell,
  onHandlePointerDown,
}: Props) {
  const { setNote } = useGenStore();

  return (
    <ClipNoteCard
      images={images}
      cardId={cellId}
      note={note}
      dragOver={dragOver}
      imageColClassName="flex-1"
      textColClassName="w-[160px]"
      noteHeader={
        <div className="flex items-center justify-between px-2.5 py-1.5 border-b border-[#3D3D3D]">
          <span className="text-[11px] text-[#8A8A8A] flex items-center gap-1">
            {onHandlePointerDown && (
              <span
                onPointerDown={onHandlePointerDown}
                className="shrink-0 cursor-grab active:cursor-grabbing select-none opacity-0 group-hover/card:opacity-100 transition-opacity"
                title="拖动排序"
              >
                <GripVertical size={12} className="text-[#555555]" />
              </span>
            )}
            <Type size={10} />
            备注
          </span>
          <button
            className="text-[#555555] hover:text-red-400 transition-colors"
            onClick={onDeleteCell}
            title="删除此格子"
          >
            <Trash2 size={11} />
          </button>
        </div>
      }
      onReorder={onReorder}
      onDeleteImage={onDeleteImage}
      onNoteChange={(json) => setNote(cellId, json)}
    />
  );
}
