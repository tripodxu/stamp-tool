import { useEffect, useState, type ReactNode } from 'react';
import type { PageInfo, Stamp, SealImage } from '../lib/types';
import { mmToPt, ptToMm, STANDARD_SEAL_MM } from '../lib/units';
import { assessSealQuality } from '../lib/seal';
import { PRESET_LABELS, type StampPreset } from '../lib/geometry';
import { SealLibrary } from './SealLibrary';
import { sealRecordId, type SavedSeal } from '../lib/sealStore';

interface Props {
  seal: SealImage | null;
  stamp: Stamp | null;
  page: PageInfo | null;
  pageCount: number;
  seals: SavedSeal[];
  onUpdate: (id: string, patch: Partial<Stamp>, history?: boolean) => void;
  /** 连续交互（滑杆拖动）的起点入栈 */
  onBeginEdit: () => void;
  onApplyPreset: (id: string, kind: StampPreset) => void;
  onCopyAllPages: (id: string) => void;
  /** 盖到指定页：'1,3,5-8' / '末页' / 留空＝全部 */
  onStampOnPages: (id: string, spec: string) => void;
  onRemove: (id: string) => void;
  onUseSeal: (seal: SavedSeal) => void;
  onDeleteSeal: (id: string) => void;
  onRenameSeal: (id: string, name: string) => void;
  onDedupeSeals: () => void;
  onClearSeals: () => void;
}

/** 面板外壳 + 常驻的印章库：无论当前有没有选中的章，都能一键换章。 */
function Panel({
  children,
  library,
}: {
  children: ReactNode;
  library: ReactNode;
}) {
  return (
    <aside className="panel">
      {children}
      {library}
    </aside>
  );
}

export function Inspector({
  seal,
  stamp,
  page,
  pageCount,
  seals,
  onUpdate,
  onBeginEdit,
  onApplyPreset,
  onCopyAllPages,
  onStampOnPages,
  onRemove,
  onUseSeal,
  onDeleteSeal,
  onRenameSeal,
  onDedupeSeals,
  onClearSeals,
}: Props) {
  /** 「盖到…」输入框里的页码，回车或点按钮才生效 */
  const [range, setRange] = useState('');
  const library = (
    <SealLibrary
      seals={seals}
      activeId={seal ? sealRecordId(seal) : null}
      onUse={onUseSeal}
      onDelete={onDeleteSeal}
      onRename={onRenameSeal}
      onDedupe={onDedupeSeals}
      onClear={onClearSeals}
    />
  );

  if (!seal) {
    return (
      <Panel library={library}>
        <h2>操作</h2>
        <ol className="steps">
          <li>选择要盖章的 PDF 文件</li>
          <li>上传背景透明的公章图片</li>
          <li>拖动调整位置，拖右下角调整大小</li>
          <li>用「落款处 / 右下角 / 骑缝（左·右）」一键摆放</li>
          <li>导出 PDF</li>
        </ol>
        <p className="note">
          印章建议使用 <strong>PNG</strong> 格式；系统会自动去除白边并裁剪到墨迹边界。
          手机翻拍的照片也能直接用。PDF 与印章都可以直接拖到窗口里。
        </p>
      </Panel>
    );
  }

  if (!stamp) {
    const q = assessSealQuality(seal.cropW, STANDARD_SEAL_MM);
    return (
      <Panel library={library}>
        <h2>印章</h2>
        <div className="seal-preview">
          <img src={seal.objectUrl} alt="印章预览" />
        </div>
        <dl className="kv">
          <dt>原始尺寸</dt>
          <dd>{seal.srcW} × {seal.srcH} px</dd>
          <dt>墨迹尺寸</dt>
          <dd>{seal.cropW} × {seal.cropH} px</dd>
        </dl>
        <ul className="checks">
          <li className={seal.bgMode === 'paper' ? 'warn' : 'ok'}>
            {seal.bgMode === 'paper'
              ? '翻拍/扫描件：已按纸张去背，并还原为实心墨色'
              : '透明底 PNG：按自身 alpha 处理'}
          </li>
          {seal.bgMode === 'alpha' && (
            <li className={seal.hadFringe ? 'warn' : 'ok'}>
              {seal.hadFringe
                ? `已去除白边像素（占 ${(seal.fringeRatio * 100).toFixed(1)}%）`
                : '未检测到白边'}
            </li>
          )}
          <li className={seal.trimmed ? 'ok' : 'muted'}>
            {seal.trimmed ? '已裁剪到墨迹边界' : '无多余留白'}
          </li>
          <li className={`q-${q.level}`}>{q.text}</li>
        </ul>
        <p className="note">点击「放置印章」在当前页添加一枚章。</p>
      </Panel>
    );
  }

  const widthMm = ptToMm(stamp.widthPt);
  /**
   * 长宽比与像素数都取**这枚章自己的**，不能用当前加载的 seal：
   * 换过印章之后旧章仍在用旧图，拿新图的宽高比去改尺寸会把圆章拉成椭圆
   * （实测 40mm 圆章 → 39.8 × 53.2mm），而且预览里看不出来。
   * 老状态的章没有这两个字段时按自身宽高比兜底。
   */
  const aspect = stamp.aspect || stamp.widthPt / stamp.heightPt;
  const q = assessSealQuality(stamp.cropW, widthMm);
  /** 离散操作（预设、摆正、快捷尺寸）：一次点击=一次历史，直接入栈。 */
  const set = (patch: Partial<Stamp>) => onUpdate(stamp.id, patch);
  /** 连续交互：起点由 beginEdit 记，过程中不入栈。 */
  const live = (patch: Partial<Stamp>) => onUpdate(stamp.id, patch, false);

  return (
    <Panel library={library}>
      <h2>所选印章</h2>

      <div className="field-label">位置预设</div>
      <div className="quick-sizes">
        {(Object.keys(PRESET_LABELS) as StampPreset[]).map((kind) => (
          <button
            key={kind}
            className="chip"
            onClick={() => onApplyPreset(stamp.id, kind)}
            disabled={!page}
            title={PRESET_HINTS[kind]}
          >
            {PRESET_LABELS[kind]}
          </button>
        ))}
      </div>

      <label className="field">
        <span>
          直径 <b>{widthMm.toFixed(1)} mm</b>
        </span>
        <input
          type="range"
          min={10}
          max={80}
          step={0.5}
          value={Number(widthMm.toFixed(1))}
          onPointerDown={onBeginEdit}
          onFocus={onBeginEdit}
          onChange={(e) => {
            const w = mmToPt(Number(e.target.value));
            live({ widthPt: w, heightPt: w / aspect });
          }}
        />
      </label>
      <div className="quick-sizes">
        {[20, 30, 40, 42].map((mm) => (
          <button
            key={mm}
            className={Math.abs(widthMm - mm) < 0.3 ? 'chip active' : 'chip'}
            onClick={() => {
              const w = mmToPt(mm);
              set({ widthPt: w, heightPt: w / aspect });
            }}
          >
            {mm}mm
          </button>
        ))}
      </div>

      {/* 位置精确输入：公文排版要求「差 0.5mm 也看得出来」，拖拽永远不够准 */}
      <div className="field-label">位置（自页面左上角）</div>
      <div className="xy-inputs">
        <label>
          <span>X</span>
          <MmInput
            value={ptToMm(stamp.xPt)}
            onCommit={(mm) => set({ xPt: mmToPt(mm) })}
          />
        </label>
        <label>
          <span>Y</span>
          <MmInput
            value={ptToMm(stamp.yPt)}
            onCommit={(mm) => set({ yPt: mmToPt(mm) })}
          />
        </label>
      </div>

      <label className="field">
        <span>
          旋转 <b>{stamp.rotationDeg.toFixed(0)}°</b>
        </span>
        <input
          type="range"
          // 范围跟着真实角度走：拖手柄能转到 ±180，写死 ±45 会被浏览器钳在端点，
          // 于是滑块显示 45° 而标签显示 120°，用户一碰滑块章就"跳"回去。
          min={Math.min(-45, Math.floor(stamp.rotationDeg))}
          max={Math.max(45, Math.ceil(stamp.rotationDeg))}
          step={1}
          value={stamp.rotationDeg}
          onPointerDown={onBeginEdit}
          onFocus={onBeginEdit}
          onChange={(e) => live({ rotationDeg: Number(e.target.value) })}
        />
      </label>
      <div className="quick-sizes">
        <button className="chip" onClick={() => set({ rotationDeg: 0 })}>
          一键摆正
        </button>
      </div>

      <label className="field">
        <span>
          印油浓度 <b>{Math.round(stamp.opacity * 100)}%</b>
        </span>
        <input
          type="range"
          min={0.1}
          max={1}
          step={0.01}
          value={stamp.opacity}
          onPointerDown={onBeginEdit}
          onFocus={onBeginEdit}
          onChange={(e) => live({ opacity: Number(e.target.value) })}
        />
      </label>

      <div className={`quality q-${q.level}`}>{q.text}</div>

      {pageCount > 1 && (
        <button className="ghost" onClick={() => onCopyAllPages(stamp.id)}>
          复制到全部 {pageCount} 页
        </button>
      )}

      <div className="range-row">
        <input
          className="page-range-input"
          value={range}
          placeholder="1,3,5-8 或 末页"
          title="把这枚章盖到这些页；留空＝全部页"
          onChange={(e) => setRange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onStampOnPages(stamp.id, range);
            }
          }}
        />
        <button
          className="ghost"
          title="把这枚章按同样的位置与参数盖到这些页"
          onClick={() => onStampOnPages(stamp.id, range)}
        >
          盖到…
        </button>
      </div>

      <button className="danger" onClick={() => onRemove(stamp.id)}>
        删除这枚印章
      </button>
    </Panel>
  );
}

const PRESET_HINTS: Record<StampPreset, string> = {
  signature: '正文下方偏左的落款位置',
  rightBottom: '页面右下角，距边 12mm',
  bindingEdgeLeft: '章心压在页面左边缘（左侧装订），一半在页外',
  bindingEdgeRight: '章心压在页面右边缘（右侧装订），一半在页外',
};

/**
 * 毫米数字输入。
 *
 * 输入过程只改本地草稿（否则每敲一个字符就压一条历史，撤销栈秒满），
 * 失焦或回车才提交一次。
 */
function MmInput({
  value,
  onCommit,
}: {
  value: number;
  onCommit: (mm: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value.toFixed(1);

  useEffect(() => {
    // 外部值变化（撤销、拖动）时丢弃草稿
    setDraft(null);
  }, [value]);

  const commit = () => {
    if (draft === null) return;
    const n = Number(draft);
    setDraft(null);
    if (Number.isFinite(n)) onCommit(n);
  };

  return (
    <input
      type="number"
      inputMode="decimal"
      step={0.5}
      value={shown}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        }
      }}
    />
  );
}
