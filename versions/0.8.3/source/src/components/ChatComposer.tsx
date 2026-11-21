import { ArrowUp, File, FolderOpen, Image, LoaderCircle, Paperclip, Plus, X } from "lucide-react";
import { useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { ChatAttachment, DesktopBridge } from "../types";
import "./chat-composer.css";

const attachmentError = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': Error: /, "");

function AttachmentTile({ attachment, remove, api }: { attachment: ChatAttachment; remove?: () => void; api: DesktopBridge }) {
  const [preview, setPreview] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (!attachment.mediaType) return;
    let current = true;
    void api.previewChatAttachment(attachment.id).then((url) => { if (current) setPreview(url); }).catch(() => { if (current) setFailed(true); });
    return () => { current = false; };
  }, [api, attachment.id, attachment.mediaType]);
  const size = attachment.size >= 1024 * 1024 ? `${(attachment.size / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.ceil(attachment.size / 1024))} KB`;
  return <div className={`ar-chat-file${preview ? " ar-chat-file--image" : ""}`}>
    <button type="button" className="ar-chat-file-main" title={attachment.name} aria-label={`查看附件 ${attachment.name}`} onClick={() => {
      if (preview) dialog.current?.showModal();
      else void api.revealChatAttachment(attachment.id).catch(() => setFailed(true));
    }}>
      {preview ? <img src={preview} alt={attachment.name} /> : <span className="ar-chat-file-icon">{attachment.mediaType ? <Image size={16} /> : <File size={16} />}</span>}
      <span className="ar-chat-file-label"><strong>{attachment.name}</strong>{!preview && <small>{failed ? "附件不可用" : size}</small>}</span>
    </button>
    {remove && <button type="button" className="ar-chat-file-remove" title="移除附件" aria-label={`移除附件 ${attachment.name}`} onClick={remove}><X size={13} /></button>}
    {preview && <dialog ref={dialog} className="ar-chat-image-dialog" aria-label={attachment.name}>
      <div><strong>{attachment.name}</strong><button type="button" className="ar-chat-icon" aria-label="关闭图片" onClick={() => dialog.current?.close()}><X size={18} /></button></div>
      <img src={preview} alt={attachment.name} />
    </dialog>}
  </div>;
}

export function ChatAttachments({ files = [], onRemove, api = window.autoresearch }: { files?: ChatAttachment[]; onRemove?: (id: string) => void; api?: DesktopBridge }) {
  if (!files.length) return null;
  return <div className="ar-chat-files" aria-label="附件">
    {files.map((file) => <AttachmentTile key={file.id} attachment={file} api={api} remove={onRemove ? () => onRemove(file.id) : undefined} />)}
  </div>;
}

export function ChatComposer({ label, placeholder, value, onChange, files, setFiles, onSubmit, action, status, disabled, busy, maxLength = 8000, api = window.autoresearch }: {
  label: string;
  placeholder?: string;
  value: string;
  onChange: (value: string) => void;
  files: ChatAttachment[];
  setFiles: Dispatch<SetStateAction<ChatAttachment[]>>;
  onSubmit?: () => void;
  action?: ReactNode;
  status?: ReactNode;
  disabled?: boolean;
  busy?: boolean;
  maxLength?: number;
  api?: DesktopBridge;
}) {
  const [choosing, setChoosing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [menu, setMenu] = useState(false);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const dragDepth = useRef(0);
  const importing = useRef(false);
  const canSend = Boolean(onSubmit && !disabled && !busy && !choosing && (value.trim() || files.length));

  useEffect(() => {
    if (!textarea.current) return;
    textarea.current.style.height = "auto";
    textarea.current.style.height = `${textarea.current.scrollHeight}px`;
  }, [value]);

  const add = async (load: () => Promise<ChatAttachment[]>) => {
    if (disabled || busy || importing.current) return;
    importing.current = true;
    setMenu(false);
    setChoosing(true);
    setError("");
    try {
      const imported = await load();
      const combined = [...files, ...imported];
      if (combined.length > 50 || combined.reduce((sum, file) => sum + file.size, 0) > 100 * 1024 * 1024) {
        setError("每条消息最多添加 50 个文件，总大小不超过 100 MB。");
      } else setFiles(combined);
    } catch (reason) { setError(attachmentError(reason)); }
    finally { importing.current = false; setChoosing(false); }
  };

  return <div className={`ar-chat-compose${dragging ? " is-dragging" : ""}`}
    onDragEnter={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); dragDepth.current += 1;
      if (!disabled && !busy) setDragging(true);
    }}
    onDragOver={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); event.dataTransfer.dropEffect = disabled || busy ? "none" : "copy";
    }}
    onDragLeave={() => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); }}
    onDrop={(event) => {
      if (!event.dataTransfer.types.includes("Files")) return;
      event.preventDefault(); event.stopPropagation(); dragDepth.current = 0; setDragging(false);
      const dropped = Array.from(event.dataTransfer.files);
      if (dropped.length) void add(() => api.importChatAttachments(dropped));
    }}>
    <ChatAttachments files={files} api={api} onRemove={disabled || busy || choosing ? undefined : (id) => setFiles((current) => current.filter((file) => file.id !== id))} />
    <textarea ref={textarea} aria-label={label} placeholder={placeholder} rows={2} maxLength={maxLength} disabled={disabled} value={value}
      onChange={(event) => onChange(event.target.value)}
      onPaste={(event) => {
        const pasted = Array.from(event.clipboardData.files);
        if (!pasted.length) return;
        if (!event.clipboardData.getData("text/plain")) event.preventDefault();
        void add(() => api.importChatAttachments(pasted));
      }}
      onKeyDown={(event) => {
        if (!onSubmit || event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
        event.preventDefault();
        if (canSend) onSubmit();
      }} />
    <div className="ar-chat-tools">
      <div className="ar-chat-add" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setMenu(false); }}
        onKeyDown={(event) => { if (event.key === "Escape") { setMenu(false); textarea.current?.focus(); } }}>
        <button className="ar-chat-icon" type="button" title="添加附件" aria-label="添加附件" aria-expanded={menu} disabled={disabled || busy || choosing} onClick={() => setMenu(!menu)}>
          {choosing ? <LoaderCircle className="spin" size={17} /> : <Plus size={19} />}
        </button>
        {menu && <div className="ar-chat-add-menu" aria-label="添加附件选项">
          <button type="button" onClick={() => void add(() => api.chooseChatAttachments(false))}><Paperclip size={16} />添加文件</button>
          <button type="button" onClick={() => void add(() => api.chooseChatAttachments(true))}><FolderOpen size={16} />添加文件夹</button>
          <small>也可拖入文件或粘贴截图</small>
        </div>}
      </div>
      <span className="ar-chat-status" role={error ? "alert" : undefined}>{error || (dragging ? "松开即可添加附件" : choosing ? "正在导入附件…" : status)}</span>
      {action}
      {onSubmit && <button type="button" className="ar-chat-icon ar-chat-send" title="发送（Enter）" aria-label="发送消息" disabled={!canSend} onClick={onSubmit}>{busy ? <LoaderCircle className="spin" size={17} /> : <ArrowUp size={19} />}</button>}
    </div>
  </div>;
}
