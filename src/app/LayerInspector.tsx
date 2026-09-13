import type { Anime25DRuntime } from "../engine/anime25d/Anime25DRuntime"
import type { RigDiagnostics } from "../engine/anime25d/types"

export function LayerInspector({ diagnostics, runtime }: { diagnostics: RigDiagnostics; runtime: Anime25DRuntime }) {
  return (
    <div className="inspector-body">
      <div className="button-row inspector-actions">
        <button className="button button-quiet" type="button" onClick={() => runtime.clearLayerFilters()}>Show all</button>
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
                <button type="button" disabled={adapterHidden} onClick={() => runtime.setLayerVisible(layer.name, hidden, layer.normalizedName)}>{adapterHidden ? "adapter hidden" : hidden ? "show" : "hide"}</button>
                <button type="button" disabled={adapterHidden} className={isolated ? "is-on" : ""} onClick={() => runtime.isolateLayer(isolated ? null : layer.name, layer.normalizedName)}>solo</button>
              </div>
              <dl>
                <div><dt>normalized</dt><dd>{layer.normalizedName}</dd></div>
                <div><dt>group / fade / side</dt><dd>{layer.group} / {layer.fade ?? "—"} / {layer.side}</dd></div>
                <div><dt>bounds</dt><dd>{bounds.x0},{bounds.y0} → {bounds.x1},{bounds.y1}</dd></div>
                <div><dt>alpha raw → clean</dt><dd>{layer.alphaBefore.toLocaleString()} → {layer.alphaAfter.toLocaleString()}</dd></div>
                <div><dt>strands</dt><dd>{layer.hairStrands}</dd></div>
              </dl>
            </li>
          )
        })}
      </ol>
    </div>
  )
}
