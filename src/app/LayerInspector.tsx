import { useT } from "../i18n/useLanguage"
import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import type { RigDiagnostics } from "../engine/anime25d/types"

export function LayerInspector({ diagnostics, runtime }: { diagnostics: RigDiagnostics; runtime: Anime25DRuntime }) {
  const t = useT()
  return (
    <div className="inspector-body">
      <div className="button-row inspector-actions">
        <button className="button button-quiet" type="button" onClick={() => runtime.clearLayerFilters()}>{t("전체 표시")}</button>
      </div>
      <ol className="layer-inspector-list">
        {diagnostics.layerInspections.map((layer) => {
          const adapterHidden = !layer.visible
          const hidden = adapterHidden || diagnostics.hiddenLayers.includes(layer.name)
          const isolated = diagnostics.isolatedLayer === layer.name
          const bounds = layer.bounds
          return (
            <li key={layer.id} className={hidden ? "is-hidden" : isolated ? "is-isolated" : ""}>
              <div className="layer-title"><span>{layer.order + 1}</span><b>{layer.name}</b></div>
              <div className="layer-actions">
                <button type="button" disabled={adapterHidden} onClick={() => runtime.setLayerVisible(layer.name, hidden, layer.normalizedName)}>{adapterHidden ? t("리깅 도구에서 숨김") : hidden ? t("표시") : t("숨기기")}</button>
                <button type="button" disabled={adapterHidden} className={isolated ? "is-on" : ""} onClick={() => runtime.isolateLayer(isolated ? null : layer.name, layer.normalizedName)}>{t("단독")}</button>
              </div>
              <dl>
                <div><dt>{t("정규화")}</dt><dd>{layer.normalizedName}</dd></div>
                <div><dt>{t("그룹 / 페이드 / 방향")}</dt><dd>{layer.group} / {layer.fade ?? "—"} / {layer.side}</dd></div>
                <div><dt>{t("경계")}</dt><dd>{bounds.x0},{bounds.y0} → {bounds.x1},{bounds.y1}</dd></div>
                <div><dt>{t("알파 원본 → 정리")}</dt><dd>{layer.alphaBefore.toLocaleString(t.locale)} → {layer.alphaAfter.toLocaleString(t.locale)}</dd></div>
                <div><dt>{t("가닥")}</dt><dd>{layer.hairStrands}</dd></div>
              </dl>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
