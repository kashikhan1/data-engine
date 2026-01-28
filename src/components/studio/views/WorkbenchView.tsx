'use client';

import React, { useState } from 'react';
import { Widget } from '@/types/studio';

interface WorkbenchViewProps {
    widgets: Widget[];
    selectedWidget: Widget;
}

const WorkbenchView: React.FC<WorkbenchViewProps> = ({ widgets, selectedWidget }) => {
    const [activeTab, setActiveTab] = useState<'sql' | 'python'>('sql');
    const [sqlCode, setSqlCode] = useState(`-- SQL Query for Sales Data
SELECT 
  region,
  SUM(revenue) AS total_revenue,
  AVG(deal_size) AS avg_deal_size
FROM 
  sales_data_q3
WHERE 
  transaction_date BETWEEN '2023-10-01'
AND '2023-12-31'
GROUP BY 
  region
ORDER BY 
  total_revenue DESC;

-- Additional data for product mix
SELECT 
  category,
  COUNT(*) AS total_units
FROM 
  product_transactions
GROUP BY 
  category;`);

    const widgetConfig = `widget_id: BAR_CHART_1
widget_type: BarChart
position:
  col_start: 5
  col_end: 12
  row_start: 3
  row_end: 8
data_config:
  source: sales_data_q3
  x_axis:
    field: region
    type: category
  y_axis:
    series:
      - field: revenue
        aggregation: sum
        color: "#FFFFFF"
      - field: profit
        aggregation: sum
        color: "#CCCCCC"
filters:
  - field: transaction_date
    operator: between
    value: ["2023-10-01", "2023-12-31"]
appearance:
  title: "REVENUE_BY_REGION"
  show_legend: false
  border_style: solid
  border_width: 2px
  border_color: "#FFFFFF"
  background_color: "#000000"
  padding: "12px"
  font_family: Roboto Mono
  font_size: 14px`;

    return (
        <div className="flex flex-1 h-full overflow-hidden bg-black font-mono">
            {/* Left: Editor Column */}
            <div className="w-[450px] flex flex-col border-r border-[#2d3748] bg-black">
                <div className="flex border-b border-[#2d3748] h-10 shrink-0">
                    <button
                        onClick={() => setActiveTab('sql')}
                        className={`flex-1 flex items-center justify-center text-[10px] font-bold uppercase tracking-[2px] border-r border-[#2d3748] ${activeTab === 'sql' ? 'bg-[#111318] text-white shadow-[inset_0_-2px_0_white]' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        SQL_Editor
                    </button>
                    <button
                        onClick={() => setActiveTab('python')}
                        className={`flex-1 flex items-center justify-center text-[10px] font-bold uppercase tracking-[2px] ${activeTab === 'python' ? 'bg-[#111318] text-white shadow-[inset_0_-2px_0_white]' : 'text-slate-500 hover:text-slate-300'}`}
                    >
                        Python_Script
                    </button>
                </div>

                <div className="flex-1 relative overflow-hidden group">
                    <textarea
                        value={sqlCode}
                        onChange={(e) => setSqlCode(e.target.value)}
                        className="w-full h-full bg-transparent text-slate-300 p-6 focus:outline-none resize-none scrollbar-hide text-sm leading-relaxed"
                        spellCheck={false}
                    />
                </div>

                {/* Output Console */}
                <div className="h-64 border-t border-[#2d3748] flex flex-col bg-[#050505]">
                    <div className="px-4 py-2 flex items-center justify-between border-b border-[#2d3748] h-8">
                        <span className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Output Console</span>
                        <button className="text-slate-500 hover:text-white transition-colors">
                            <span className="material-symbols-outlined text-[16px]">close</span>
                        </button>
                    </div>
                    <div className="flex-1 p-4 overflow-y-auto text-[11px] space-y-2">
                        <p className="text-green-500 font-bold tracking-tight">{'>'} QUERY EXECUTED. STATUS: OK (200ms)</p>
                        <p className="text-green-500 font-bold tracking-tight">{'>'} ROWS AFFECTED: 4 (sales_data_q3)</p>
                        <p className="text-green-500 font-bold tracking-tight">{'>'} ROWS AFFECTED: 5 (product_transactions)</p>
                    </div>
                    <div className="p-3 border-t border-[#2d3748] bg-[#0b0d11]">
                        <button className="w-full py-2 bg-[#111318] border border-[#2d3748] rounded text-[10px] font-bold uppercase tracking-[2px] text-white hover:bg-white/5 transition-all flex items-center justify-center gap-2">
                            <span className="material-symbols-outlined text-[16px]">play_arrow</span>
                            Run Query
                        </button>
                    </div>
                </div>
            </div>

            {/* Center: Dashboard Preview */}
            <div className="flex-1 overflow-y-auto p-12 canvas-grid relative flex justify-center items-start">
                {/* Preview Toolbar */}
                <div className="absolute top-6 left-1/2 -translate-x-1/2 z-30 bg-[#111318]/90 border border-[#2d3748] rounded px-2 py-1.5 flex items-center gap-2">
                    <button className="p-1 text-slate-500 hover:text-white transition-colors"><span className="material-symbols-outlined text-[18px]">undo</span></button>
                    <button className="p-1 text-slate-500 hover:text-white transition-colors"><span className="material-symbols-outlined text-[18px]">redo</span></button>
                    <div className="w-px h-4 bg-[#2d3748] mx-1"></div>
                    <button className="p-1 text-white bg-white/10 rounded"><span className="material-symbols-outlined text-[18px]">desktop_windows</span></button>
                    <button className="p-1 text-slate-500 hover:text-white transition-colors"><span className="material-symbols-outlined text-[18px]">tablet_mac</span></button>
                    <button className="p-1 text-slate-500 hover:text-white transition-colors"><span className="material-symbols-outlined text-[18px]">smartphone</span></button>
                    <div className="w-px h-4 bg-[#2d3748] mx-1"></div>
                    <span className="text-[10px] font-bold text-slate-500 px-1">1:1</span>
                </div>

                <div className="w-full max-w-[800px] bg-black border border-slate-700 rounded shadow-2xl overflow-hidden p-8 space-y-10 min-h-[1200px]">
                    {/* Dashboard Frame Header */}
                    <div className="flex justify-between items-start">
                        <div>
                            <h2 className="text-2xl font-bold text-white tracking-tighter uppercase mb-1">Q3_SALES_PERFORMANCE</h2>
                            <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Regional_Breakdown_Revenue_Units</p>
                        </div>
                        <div className="px-3 py-1.5 border border-[#2d3748] rounded bg-[#0b0d11] flex items-center gap-3">
                            <span className="material-symbols-outlined text-slate-500 text-[16px]">calendar_month</span>
                            <span className="text-[10px] text-slate-400 font-bold uppercase">2023-10-01 - 2023-12-31</span>
                        </div>
                    </div>

                    {/* KPI Row */}
                    <div className="grid grid-cols-3 gap-6">
                        <div className="border border-slate-700 p-5 bg-[#0b0d11] relative">
                            <span className="absolute top-2 right-2 material-symbols-outlined text-green-500 text-[18px]">trending_up</span>
                            <h4 className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-2">Total_Revenue</h4>
                            <div className="text-3xl font-bold text-white tracking-tighter">$1,245,000</div>
                            <div className="text-green-500 text-[10px] font-bold mt-1">+12.5% <span className="text-slate-500 uppercase">vs_last_qrtr</span></div>
                        </div>
                        <div className="border border-slate-700 p-5 bg-[#0b0d11] relative">
                            <span className="absolute top-2 right-2 material-symbols-outlined text-green-500 text-[18px]">trending_up</span>
                            <h4 className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-2">Total_Units</h4>
                            <div className="text-3xl font-bold text-white tracking-tighter">45,230</div>
                            <div className="text-green-500 text-[10px] font-bold mt-1">+5.2% <span className="text-slate-500 uppercase">vs_last_qrtr</span></div>
                        </div>
                        <div className="border border-slate-700 p-5 bg-[#0b0d11] relative">
                            <span className="absolute top-2 right-2 material-symbols-outlined text-red-500 text-[18px]">trending_down</span>
                            <h4 className="text-[10px] text-slate-500 uppercase font-bold tracking-widest mb-2">Avg_Deal_Size</h4>
                            <div className="text-3xl font-bold text-white tracking-tighter">$8,500</div>
                            <div className="text-red-500 text-[10px] font-bold mt-1">-2.1% <span className="text-slate-500 uppercase">vs_last_qrtr</span></div>
                        </div>
                    </div>

                    {/* Visual Widgets */}
                    <div className="grid grid-cols-12 gap-6">
                        <div className="col-span-8 border-2 border-white p-6 relative group bg-black">
                            <div className="absolute -top-3 left-4 bg-white text-black text-[9px] font-bold px-2 py-0.5 uppercase tracking-widest flex items-center gap-2">
                                <span className="material-symbols-outlined text-[14px]">bar_chart</span>
                                Widget_id: Bar_Chart_1
                            </div>
                            <div className="flex justify-between items-center mb-10">
                                <h3 className="text-xs font-bold text-white uppercase tracking-widest">Revenue_by_Region</h3>
                                <span className="material-symbols-outlined text-slate-500 text-[16px]">more_horiz</span>
                            </div>
                            <div className="h-48 border-l border-b border-slate-700 relative flex items-end justify-around pb-1">
                                <div className="w-10 h-24 bg-white"></div>
                                <div className="w-10 h-40 bg-white"></div>
                                <div className="w-10 h-16 bg-white"></div>
                                <div className="w-10 h-32 bg-white"></div>

                                <div className="absolute -bottom-6 inset-x-0 flex justify-around text-[9px] text-slate-500 font-bold uppercase">
                                    <span>North</span><span>South</span><span>East</span><span>West</span>
                                </div>
                            </div>
                            <div className="mt-12 flex justify-between border-t border-slate-800 pt-2 text-[8px] font-bold uppercase tracking-widest text-slate-600">
                                <span>X-Axis: Region</span>
                                <span>Y-Axis: Revenue</span>
                            </div>
                        </div>

                        <div className="col-span-4 border border-slate-700 p-6 bg-[#0b0d11] flex flex-col items-center">
                            <h3 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-6">Product_Mix_Raw</h3>
                            <div className="relative w-32 h-32 flex items-center justify-center">
                                <div className="absolute inset-0 border-4 border-slate-800 rotate-45"></div>
                                <div className="flex flex-col items-center z-10">
                                    <span className="text-4xl font-bold text-white">4</span>
                                    <span className="text-[8px] text-slate-500 font-bold uppercase">Categories</span>
                                </div>
                            </div>
                            <div className="mt-8 space-y-2 w-full text-[9px] font-bold uppercase tracking-tighter">
                                <div className="flex justify-between text-slate-400"><span>Electronics:</span><span>35%</span></div>
                                <div className="flex justify-between text-slate-400"><span>Clothing:</span><span>25%</span></div>
                                <div className="flex justify-between text-slate-400"><span>Home_Goods:</span><span>20%</span></div>
                                <div className="flex justify-between text-slate-400"><span>Other:</span><span>20%</span></div>
                            </div>
                        </div>
                    </div>

                    {/* Table Container */}
                    <div className="border border-slate-700 rounded overflow-hidden">
                        <div className="px-5 py-3 border-b border-slate-700 bg-[#0b0d11] flex justify-between items-center">
                            <h3 className="text-xs font-bold text-white uppercase tracking-widest">Detailed_Transactions_Table</h3>
                            <button className="text-[9px] font-bold border border-[#2d3748] px-2 py-1 rounded hover:bg-white/5 uppercase">Export_CSV</button>
                        </div>
                        <table className="w-full text-[10px] text-left">
                            <thead className="bg-[#0b0d11] text-slate-500 font-bold uppercase tracking-tighter border-b border-slate-700">
                                <tr>
                                    <th className="px-5 py-2 w-10"><div className="w-3 h-3 border border-slate-700"></div></th>
                                    <th className="px-5 py-2">Order_id</th>
                                    <th className="px-5 py-2">Product_name</th>
                                    <th className="px-5 py-2">Region</th>
                                    <th className="px-5 py-2 text-right">Amount</th>
                                    <th className="px-5 py-2">Status</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-slate-800 text-slate-300 font-medium">
                                <tr>
                                    <td className="px-5 py-3"><div className="w-3 h-3 border border-slate-700"></div></td>
                                    <td className="px-5 py-3 font-mono">ORD_001</td>
                                    <td className="px-5 py-3 uppercase tracking-tighter">Premium_Headphones</td>
                                    <td className="px-5 py-3 text-slate-500 uppercase">North</td>
                                    <td className="px-5 py-3 text-right font-mono">$249.00</td>
                                    <td className="px-5 py-3 text-green-500 font-bold uppercase">Paid</td>
                                </tr>
                                <tr>
                                    <td className="px-5 py-3"><div className="w-3 h-3 border border-slate-700"></div></td>
                                    <td className="px-5 py-3 font-mono">ORD_002</td>
                                    <td className="px-5 py-3 uppercase tracking-tighter">Ergonomic_Chair</td>
                                    <td className="px-5 py-3 text-slate-500 uppercase">South</td>
                                    <td className="px-5 py-3 text-right font-mono">$1,299.00</td>
                                    <td className="px-5 py-3 text-yellow-500 font-bold uppercase">Pending</td>
                                </tr>
                                <tr>
                                    <td className="px-5 py-3"><div className="w-3 h-3 border border-slate-700"></div></td>
                                    <td className="px-5 py-3 font-mono">ORD_003</td>
                                    <td className="px-5 py-3 uppercase tracking-tighter">Mechanical_Keyboard</td>
                                    <td className="px-5 py-3 text-slate-500 uppercase">North</td>
                                    <td className="px-5 py-3 text-right font-mono">$149.00</td>
                                    <td className="px-5 py-3 text-green-500 font-bold uppercase">Paid</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            {/* Right: Config Column */}
            <div className="w-[400px] flex flex-col border-l border-[#2d3748] bg-black overflow-hidden">
                <div className="px-6 py-2 border-b border-[#2d3748] flex items-center justify-center h-10 shrink-0">
                    <span className="text-[10px] font-bold text-white uppercase tracking-[4px]">Widget_Config</span>
                </div>

                <div className="flex-1 overflow-y-auto p-6 custom-scrollbar bg-[#050505]">
                    <pre className="text-[11px] text-slate-300 leading-relaxed font-mono whitespace-pre-wrap selection:bg-[#135bec] selection:text-white">
                        {widgetConfig}
                    </pre>
                </div>

                <div className="p-6 border-t border-[#2d3748] space-y-6 bg-[#0b0d11]">
                    <h4 className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">Edit Properties:</h4>

                    <div className="space-y-4">
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">widget_id:</label>
                            <input
                                readOnly
                                value="BAR_CHART_1"
                                className="w-full bg-[#111318] border border-[#2d3748] text-slate-300 text-xs px-3 py-2.5 rounded font-mono outline-none focus:border-white transition-colors"
                            />
                        </div>
                        <div className="space-y-2">
                            <label className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">y_axis.series[0].color:</label>
                            <input
                                defaultValue="#FFFFFF"
                                className="w-full bg-[#111318] border border-[#2d3748] text-slate-300 text-xs px-3 py-2.5 rounded font-mono outline-none focus:border-white transition-colors"
                            />
                        </div>
                    </div>
                </div>

                <div className="p-3 border-t border-[#2d3748] bg-black flex justify-between items-center text-[9px] text-slate-600 font-bold uppercase tracking-tighter">
                    <span>Last_Update: 2m ago</span>
                    <span>Format: YAML/JSON</span>
                    <span className="text-green-900">Status: Autosaving...</span>
                </div>
            </div>
        </div>
    );
};

export default WorkbenchView;
