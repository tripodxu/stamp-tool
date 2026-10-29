import { useEffect, useMemo, useRef, useState } from 'react';
import type { PageInfo, SealImage, Stamp } from '../lib/types';
import { PRESET_LABELS, defaultOpacity, type StampPreset } from '../lib/geometry';
import { mmToPt, ptToMm, STANDARD_SEAL_MM } from '../lib/units';
import { pngObjectUrl } from '../lib/pngCache';
import { fileKey, parsePageSpec, pickNewPdfs, type BatchSeed } from '../lib/batch';
import { useBatchStamp, type BatchFile } from '../state/useBatchStamp';

/**
 * 批量盖章面板。
 *
 * 交互上刻意只回答四个问题：盖哪些文件、盖哪几页、盖在哪儿、盖哪一枚章。
 * 「盖在哪儿」在批量里必须是规则而不是坐标——所以只有两种选择：沿用画布上
 * 那枚章的偏移，或者按预设重算（页面尺寸不同会自动适配）。
 */

export interface BatchPanelProps {
  seal: SealImage | null;
  /** 画布上选中的那枚章：位置/尺寸/角度的来源 */
  stamp: Stamp | null;
  page: PageInfo | null;
  /** 一次拖进多份 PDF 时预填的文件（拖放进来的那几份） */
  initialFiles?: File[];
  /** 批量是否在跑。上报给 App：Esc 关面板的捷径在 busy 时要让路 */
  onBusyChange?: (busy: boolean) => void;
  onClose: () => void;
}

const PRESETS: StampPreset[] = [
  'signature',
  'rightBottom',
  'bindingEdgeLeft',
  'bindingEdgeRight',
];

let fileSeq = 0;

/** 新的在前、去重、只留 PDF：拖进来的和手动选的走同一条路。 */
function mergeFiles(incoming: File[], prev: BatchFile[]): BatchFile[] {
  const fresh = pickNewPdfs(
    prev.map((f) => fileKey(f.file)),
    incoming,
  );
  return [...prev, ...fresh.map((file) => ({ id: `bf-${++fileSeq}`, file }))];
}

export function BatchPanel({ seal, stamp, page, initialFiles, onBusyChange, onClose }: BatchPanelProps) {
  const [files, setFiles] = useState<BatchFile[]>(() => mergeFiles(initialFiles ?? [], []));
  const [specText, setSpecText] = useState('');
  const [specError, setSpecError] = useState<string | null>(null);
  const [mode, setMode] = useState<'offset' | 'preset'>(stamp ? 'offset' : 'preset');
  const [preset, setPreset] = useState<StampPreset>('signature');
  const inputRef = useRef<HTMLInputElement>(null);
  const batch = useBatchStamp();
  const { busy, outcomes, zipSaved } = batch;

  // 批量跑着的时候，Esc 不能把面板关掉（关闭按钮 disabled、背景点击
  // 都有 busy 判断，Esc 原来是唯一的漏洞）。App 拿这个状态去拦 Esc。
  useEffect(() => {
    onBusyChange?.(busy);
    return () => onBusyChange?.(false);
  }, [busy, onBusyChange]);

  // 印章规格：画布上有章就照搬那一枚（尺寸/角度/浓度/图像），
  // 没有就按新章的默认值来——与「放置印章」按钮的行为完全一致。
  const seed: BatchSeed | null = useMemo(() => {
    if (stamp) {
      return {
        pngBytes: stamp.pngBytes,
        widthPt: stamp.widthPt,
        heightPt: stamp.heightPt,
        rotationDeg: stamp.rotationDeg,
        opacity: stamp.opacity,
        aspect: stamp.aspect,
        cropW: stamp.cropW,
      };
    }
    if (!seal) return null;
    const widthPt = mmToPt(STANDARD_SEAL_MM);
    return {
      pngBytes: seal.pngBytes,
      widthPt,
      heightPt: widthPt / (seal.aspect || 1),
      rotationDeg: -8,
      opacity: defaultOpacity(seal.bgMode),
      aspect: seal.aspect,
      cropW: seal.cropW,
    };
  }, [stamp, seal]);

  const offset = stamp ? { xPt: stamp.xPt, yPt: stamp.yPt } : null;
  const canStart = !!seed && files.length > 0 && (mode === 'preset' || !!offset);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const incoming = Array.from(list);
    setFiles((prev) => mergeFiles(incoming, prev));
    batch.reset();
  };

  const start = async () => {
    let selector;
    try {
      selector = parsePageSpec(specText);
      setSpecError(null);
    } catch (err) {
      setSpecError(err instanceof Error ? err.message : String(err));
      return;
    }
    if (!seed) return;
    await batch.run({
      files,
      selector,
      placement: mode === 'preset' ? { mode: 'preset', preset } : { mode: 'offset' },
      seed,
      origin: offset ?? { xPt: 0, yPt: 0 },
    });
  };

  const totalBytes = files.reduce((n, f) => n + f.file.size, 0);
  const okCount = outcomes.filter((o) => o.ok).length;
  const badCount = outcomes.length - okCount;
  const pct = batch.total ? Math.round((batch.done / batch.total) * 100) : 0;

  return (
    <div
      className="batch-bg"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className="batch-card" role="dialog" aria-modal="true" aria-label="批量盖章">
        <header className="batch-head">
          <h2>批量盖章</h2>
          <button className="seal-del" title="关闭" disabled={busy} onClick={onClose}>
            ×
          </button>
        </header>

        <div className="batch-body">
          <section className="batch-step">
            <h3>① 选择文件</h3>
            <p className="note-inline">
              一次可以选多份，全部用同一枚章、同一套摆放规则；处理完打包成一个 ZIP 下载。
            </p>
            <div className="batch-pick">
              <button className="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
                选择 PDF（可多选）
              </button>
              <span className="batch-count">
                已选 <b>{files.length}</b> 份{files.length > 0 && ` · ${formatSize(totalBytes)}`}
              </span>
              {files.length > 0 && (
                <button
                  className="link-btn"
                  disabled={busy}
                  onClick={() => {
                    setFiles([]);
                    batch.reset();
                  }}
                >
                  清空
                </button>
              )}
            </div>
            <input
              ref={inputRef}
              className="batch-file-input"
              data-role="batch-files"
              type="file"
              accept="application/pdf,.pdf"
              multiple
              hidden
              onChange={(e) => {
                addFiles(e.target.files);
                e.target.value = '';
              }}
            />
            {files.length > 0 && (
              <ul className="batch-files">
                {files.map((f) => (
                  <li key={f.id}>
                    <span className="batch-name" title={f.file.name}>
                      {f.file.name}
                    </span>
                    <span className="batch-size">{formatSize(f.file.size)}</span>
                    <button
                      className="seal-del"
                      title="移除"
                      disabled={busy}
                      onClick={() => {
                        setFiles((prev) => prev.filter((x) => x.id !== f.id));
                        batch.reset();
                      }}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="batch-step">
            <h3>② 盖在哪几页</h3>
            <input
              className="batch-input"
              value={specText}
              disabled={busy}
              placeholder="留空 = 全部页"
              onChange={(e) => {
                setSpecText(e.target.value);
                setSpecError(null);
              }}
            />
            <p className="note-inline">
              可以写 <code>1,3,5-8</code>，或者 <code>末页</code>（每份文件各自的最后一页）。
            </p>
            {specError && <p className="batch-err">{specError}</p>}
          </section>

          <section className="batch-step">
            <h3>③ 盖在哪儿</h3>
            <div className="batch-radios">
              <label className={mode === 'offset' && offset ? 'on' : ''}>
                <input
                  type="radio"
                  name="batch-mode"
                  checked={mode === 'offset'}
                  disabled={busy || !offset}
                  onChange={() => setMode('offset')}
                />
                沿用画布上的位置
                <span className="batch-dim">
                  {offset && page
                    ? `距页左上角 ${ptToMm(offset.xPt).toFixed(1)} × ${ptToMm(offset.yPt).toFixed(1)} mm`
                    : '（画布上还没有章）'}
                </span>
              </label>
              <label className={mode === 'preset' ? 'on' : ''}>
                <input
                  type="radio"
                  name="batch-mode"
                  checked={mode === 'preset'}
                  disabled={busy}
                  onChange={() => setMode('preset')}
                />
                按预设重算
                <span className="batch-dim">页面尺寸不同会自动适配</span>
              </label>
            </div>
            {mode === 'preset' && (
              <div className="quick-sizes">
                {PRESETS.map((k) => (
                  <button
                    key={k}
                    className={`chip${preset === k ? ' active' : ''}`}
                    disabled={busy}
                    onClick={() => setPreset(k)}
                  >
                    {PRESET_LABELS[k]}
                  </button>
                ))}
              </div>
            )}
          </section>

          <section className="batch-step">
            <h3>④ 这一枚章</h3>
            {seed ? (
              <div className="batch-seal">
                <img src={pngObjectUrl(seed.pngBytes)} alt="" />
                <div>
                  <div className="seal-name">{seal ? seal.name : '画布上的印章'}</div>
                  <div className="seal-sub">
                    宽 {ptToMm(seed.widthPt).toFixed(1)} mm · 角度 {Math.round(seed.rotationDeg)}° ·
                    浓度 {Math.round(seed.opacity * 100)}%
                  </div>
                </div>
              </div>
            ) : (
              <p className="batch-err">还没有印章：先在左边上传一枚，或者用画布上的章。</p>
            )}
          </section>

          {outcomes.length > 0 && (
            <section className="batch-step">
              <h3>结果</h3>
              {batch.zipPending ? (
                /* 手机：跑完先别动——share 需要新鲜手势，由这个按钮提供 */
                <button className="primary deliver-zip" onClick={() => void batch.deliverZip()}>
                  保存 / 分享压缩包（{batch.zipPending.name}）
                </button>
              ) : zipSaved ? (
                <p className="batch-ok">
                  已打包「{zipSaved}」，保存在「下载」文件夹里（{okCount} 份）。
                </p>
              ) : (
                <p className="batch-err">没有生成压缩包：所有文件都被跳过了。</p>
              )}
              {badCount > 0 && <p className="note-inline">其中 {badCount} 份没盖章，原因见下：</p>}
              <ul className="batch-files">
                {outcomes.map((o, i) => (
                  <li key={`${o.fileName}-${i}`}>
                    <span className={`batch-mark ${o.ok ? 'ok' : 'bad'}`}>{o.ok ? '✓' : '✗'}</span>
                    <span className="batch-name" title={o.fileName}>
                      {o.fileName}
                    </span>
                    <span className="batch-size">{o.ok ? `${o.stampedPages} 页` : o.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <footer className="batch-foot">
          {busy ? (
            <>
              <div className="batch-progress">
                <div className="batch-bar" style={{ width: `${pct}%` }} />
                <span>{batch.label || '处理中…'}</span>
              </div>
              {/* 跑起来以前只能干等。取消＝停在下一份的边界，已完成的部分照常打包 */}
              <button onClick={batch.cancel}>取消</button>
            </>
          ) : (
            <>
              <span className="batch-dim">
                {outcomes.length > 0 ? `上一批：成功 ${okCount} 份` : ''}
              </span>
              <button className="primary" disabled={!canStart} onClick={() => void start()}>
                开始批量盖章
              </button>
              <button onClick={onClose}>关闭</button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
