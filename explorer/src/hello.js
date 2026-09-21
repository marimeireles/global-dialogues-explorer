// M0: prove the chain parquet -> DuckDB-WASM -> Mosaic coordinator -> vgplot.
import * as vg from '@uwdata/vgplot';
import { initData } from './coordinator.js';

await initData();
document.querySelector('#chart').append(
  vg.plot(
    vg.barX(vg.from('participants'), { x: vg.count(), y: 'region', fill: 'var(--series-1)', sort: { y: '-x' } }),
    vg.xLabel('participants'), vg.yLabel(null), vg.marginLeft(80), vg.width(640), vg.height(220),
  ),
);
