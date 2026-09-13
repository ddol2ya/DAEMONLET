import { useRef, useState, type DragEvent } from "react"

export function FileDropZone({ onFile, disabled = false }: { onFile: (file: File) => Promise<void>; disabled?: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [active, setActive] = useState(false)

  const open = () => inputRef.current?.click()
  const accept = async (file?: File) => {
    if (!file) return
    if (!/\.psd$/i.test(file.name)) throw new Error("PSD 파일만 로드할 수 있습니다.")
    await onFile(file)
  }
  const drop = (event: DragEvent) => {
    event.preventDefault()
    setActive(false)
    void accept(event.dataTransfer.files[0])
  }

  return (
    <div
      className={`file-drop ${active ? "is-active" : ""}`}
      onDragEnter={(event) => { event.preventDefault(); setActive(true) }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setActive(false)}
      onDrop={drop}
    >
      <input ref={inputRef} type="file" accept=".psd,image/vnd.adobe.photoshop" hidden onChange={(event) => void accept(event.target.files?.[0])} />
      <button className="button button-primary" type="button" onClick={open} disabled={disabled}>See-through PSD 열기</button>
      <span>또는 PSD를 캔버스에 드롭</span>
    </div>
  )
}
