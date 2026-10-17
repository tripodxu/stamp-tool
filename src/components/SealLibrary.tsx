import { useEffect, useState } from 'react';
import type { SavedSeal } from '../lib/sealStore';

interface Props {
  seals: SavedSeal[];
  /** 当前正在用的那枚（按内容指纹比对） */
  activeId: string | null;
  onUse: (seal: SavedSeal) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
}

/**
 * 印章库。
 *
 * 导入过的印章会自动存进本机 IndexedDB，下次打开直接点选即可——
 * 「不用重复导入」这个需求就落在这一块。存的是处理后的 PNG，
 * 点选时不必再跑一遍去背，选中即用。
 */
export function SealLibrary({ seals, activeId, onUse, onDelete, onClear }: Props) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  /** 清空是破坏性且不可撤销的，所以要按两下 */
  const [confirmClear, setConfirmClear] = useState(false);

  // 缩略图用 objectURL，列表一变就整批回收，别让 Blob 堆积
  useEffect(() => {
    const next: Record<string, string> = {};
    for (const s of seals) {
      next[s.id] = URL.createObjectURL(
        new Blob([s.pngBytes as BlobPart], { type: 'image/png' }),
      );
    }
    setUrls(next);
    return () => {
      for (const u of Object.values(next)) URL.revokeObjectURL(u);
    };
  }, [seals]);

  return (
    <section className="seal-lib">
      <div className="field-label lib-head">
        <span>印章库{seals.length > 0 ? ` · ${seals.length} 枚` : ''}</span>
        {seals.length > 1 && (
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
                <button className="seal-item" onClick={() => onUse(s)} title={`使用「${s.name}」`}>
                  <img src={urls[s.id]} alt="" draggable={false} />
                  <span className="seal-meta">
                    <span className="seal-name">{s.name}</span>
                    <span className="seal-sub">
                      {s.cropW}×{s.cropH}px
                      {s.bgMode === 'paper' ? ' · 翻拍件' : ' · 透明底'}
                    </span>
                  </span>
                  {active && <span className="seal-badge">使用中</span>}
                </button>
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
