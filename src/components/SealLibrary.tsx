import { useEffect, useRef, useState } from 'react';
import { formatSavedAt, type SavedSeal } from '../lib/sealStore';

interface Props {
  seals: SavedSeal[];
  /** 当前正在用的那枚（按记录指纹比对） */
  activeId: string | null;
  onUse: (seal: SavedSeal) => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onDedupe: () => void;
  onClear: () => void;
}

/**
 * 印章库。
 *
 * 导入过的印章会自动存进本机 IndexedDB，下次打开直接点选即可——
 * 「不用重复导入」这个需求就落在这一块。存的是处理后的 PNG，
 * 点选时不必再跑一遍去背，选中即用。
 */
export function SealLibrary({
  seals,
  activeId,
  onUse,
  onDelete,
  onRename,
  onDedupe,
  onClear,
}: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  /** 正在生效的 objectURL（卸载时回收用）。列表一变做**增量**更新：
   *  点一次章会 bump lastUsedAt 触发整列表重渲，若整批重建 URL，
   *  全部缩略图都要重新解码（肉眼能看到闪一下）。id 不变就复用旧 URL。 */
  const liveUrls = useRef<Record<string, string>>({});
  useEffect(() => {
    const prev = liveUrls.current;
    const next: Record<string, string> = {};
    for (const s of seals) {
      next[s.id] = prev[s.id] ?? URL.createObjectURL(
        new Blob([s.pngBytes as BlobPart], { type: 'image/png' }),
      );
    }
    for (const [id, u] of Object.entries(prev)) {
      if (!(id in next)) URL.revokeObjectURL(u);
    }
    liveUrls.current = next;
    setUrls(next);
  }, [seals]);
  useEffect(
    () => () => {
      for (const u of Object.values(liveUrls.current)) URL.revokeObjectURL(u);
    },
    [],
  );
  /** 清空是破坏性且不可撤销的，所以要按两下 */
  const [confirmClear, setConfirmClear] = useState(false);
  /** 正在改名的那条 */
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const startRename = (s: SavedSeal) => {
    setEditing(s.id);
    setDraft(s.name);
  };

  const commitRename = (id: string) => {
    if (editing !== id) return;
    setEditing(null);
    onRename(id, draft);
  };

  return (
    <section className="seal-lib">
      <div className="field-label lib-head">
        <span>印章库{seals.length > 0 ? ` · ${seals.length} 枚` : ''}</span>
        {seals.length > 1 && (
          <span className="lib-actions">
            <button
              className="link-btn"
              title="把同一枚章的重复记录合并成一条"
              onClick={onDedupe}
            >
              清理重复
            </button>
            <button
              className="link-btn"
              title="清空本机保存的印章"
              onClick={() => {
                if (!confirmClear) {
                  setConfirmClear(true);
                  return;
                }
                setConfirmClear(false);
                onClear();
              }}
            >
              {confirmClear ? '再点一次确认清空' : '清空'}
            </button>
          </span>
        )}
      </div>

      {seals.length === 0 ? (
        <p className="note-inline">
          导入过的印章会自动保存在本机，下次打开直接点选，不用重新导入。
        </p>
      ) : (
        <ul className="seal-list">
          {seals.map((s) => {
            const active = s.id === activeId;
            return (
              <li key={s.id} className={active ? 'active' : undefined}>
                <button
                  className="seal-item"
                  onClick={() => onUse(s)}
                  title={`使用「${s.name}」`}
                  aria-label={`使用${s.name}`}
                >
                  <img src={urls[s.id]} alt="" draggable={false} />
                </button>
                <div className="seal-meta">
                  <span className="seal-row">
                    {editing === s.id ? (
                      <input
                        className="seal-name-input"
                        value={draft}
                        autoFocus
                        maxLength={40}
                        onChange={(e) => setDraft(e.target.value)}
                        onBlur={() => commitRename(s.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            commitRename(s.id);
                          } else if (e.key === 'Escape') {
                            e.preventDefault();
                            setEditing(null);
                          }
                        }}
                      />
                    ) : (
                      <span
                        className="seal-name"
                        title="双击改名"
                        onDoubleClick={() => startRename(s)}
                      >
                        {s.name}
                      </span>
                    )}
                    {active && editing !== s.id && <span className="seal-badge">使用中</span>}
                  </span>
                  <span className="seal-sub">
                    {s.cropW}×{s.cropH}px
                    {s.bgMode === 'paper' ? ' · 翻拍件' : ' · 透明底'}
                    {s.savedAt ? ` · ${formatSavedAt(s.savedAt)}` : ''}
                  </span>
                </div>
                <button
                  className="seal-del"
                  onClick={() => onDelete(s.id)}
                  aria-label={`从印章库删除 ${s.name}`}
                  title="从印章库删除"
                >
                  ×
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
