import { useEffect, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';

// Inline-editable material name. Double-click (or the pencil) enters edit mode;
// Enter/blur confirms, Escape cancels. Shared by the in-project panel and the
// standalone library page so rename behavior stays identical.
export default function EditableName({
  name,
  isEditing,
  onStartEdit,
  onConfirm,
  onCancel,
  textClass = 'text-[12px] text-[#E5E5E5]',
}: {
  name: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onConfirm: (newName: string) => void;
  onCancel: () => void;
  textClass?: string;
}) {
  const [value, setValue] = useState(name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  useEffect(() => {
    setValue(name);
  }, [name, isEditing]);

  if (isEditing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onConfirm(value);
          if (e.key === 'Escape') onCancel();
        }}
        onBlur={() => onConfirm(value)}
        className="w-full bg-[#1E1E1E] text-[#E5E5E5] text-[12px] px-1.5 py-0.5 rounded outline-none ring-1 ring-[#2EC4B6]"
      />
    );
  }

  return (
    <div
      className={`group/name flex items-center gap-1 min-w-0 cursor-pointer ${textClass}`}
      onDoubleClick={onStartEdit}
      title="双击重命名"
    >
      <span className="truncate">{name}</span>
      <Pencil
        size={10}
        className="text-[#666666] opacity-0 group-hover/name:opacity-100 transition-opacity shrink-0 hover:text-[#2EC4B6]"
        onClick={(e) => {
          e.stopPropagation();
          onStartEdit();
        }}
      />
    </div>
  );
}
