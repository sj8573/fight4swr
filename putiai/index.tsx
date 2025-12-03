import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";
import { Upload, X, Play, Image as ImageIcon, Check, AlertCircle, Loader2, Download, Trash2, Settings, Plus } from 'lucide-react';

// Types
interface QueueItem {
  id: string;
  file: File;
  previewUrl: string;
  status: 'idle' | 'processing' | 'success' | 'error';
  resultUrl?: string;
  customPrompt?: string;
  errorMsg?: string;
}

const App = () => {
  const [hasKey, setHasKey] = useState(false);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  // Initial prompt kept in English to maintain model performance as requested
  const [globalPrompt, setGlobalPrompt] = useState("Keep the exact composition and background. Replace the text with the following Traditional Chinese text. Ensure typography is sharp, high-definition, and legible: ");
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Effect to check for API Key
  useEffect(() => {
    const checkKey = async () => {
      if (window.aistudio) {
        const selected = await window.aistudio.hasSelectedApiKey();
        setHasKey(selected);
      }
    };
    checkKey();
    // Poll for key changes in case user sets it in another tab or dialog closes
    const interval = setInterval(checkKey, 2000);
    return () => clearInterval(interval);
  }, []);

  const handleSelectKey = async () => {
    if (window.aistudio) {
      await window.aistudio.openSelectKey();
      // We assume success or user interaction, polling will update state
    }
  };

  // Helper to process file: get Base64 and detect closest supported Aspect Ratio
  const prepareImageForGenAI = async (file: File): Promise<{ base64: string, aspectRatio: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const base64String = reader.result as string;
        const base64Data = base64String.split(',')[1];
        
        // Create an image object to get dimensions
        const img = new Image();
        img.onload = () => {
          const width = img.width;
          const height = img.height;
          const ratio = width / height;

          // Define supported aspect ratios
          const supported = [
            { id: "1:1", val: 1.0 },
            { id: "3:4", val: 0.75 },
            { id: "4:3", val: 1.3333 },
            { id: "9:16", val: 0.5625 },
            { id: "16:9", val: 1.7778 }
          ];

          // Find the closest supported ratio
          const bestMatch = supported.reduce((prev, curr) => 
            Math.abs(curr.val - ratio) < Math.abs(prev.val - ratio) ? curr : prev
          );

          resolve({ base64: base64Data, aspectRatio: bestMatch.id });
        };
        img.onerror = reject;
        img.src = base64String;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // File Handling
  const handleFiles = (files: FileList | null) => {
    if (!files) return;
    const newItems: QueueItem[] = Array.from(files).map(file => ({
      id: Math.random().toString(36).substr(2, 9),
      file,
      previewUrl: URL.createObjectURL(file),
      status: 'idle'
    }));
    setQueue(prev => [...prev, ...newItems]);
  };

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(true);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    handleFiles(e.dataTransfer.files);
  };

  const removeItem = (id: string) => {
    setQueue(prev => prev.filter(item => item.id !== id));
  };

  const updateItemPrompt = (id: string, prompt: string) => {
    setQueue(prev => prev.map(item => item.id === id ? { ...item, customPrompt: prompt } : item));
  };

  // Processing Logic
  const processQueue = async () => {
    if (isProcessing) return;
    setIsProcessing(true);

    const pendingItems = queue.filter(item => item.status === 'idle' || item.status === 'error');
    
    // We process sequentially to avoid rate limits and manage large 4K payloads
    for (const item of pendingItems) {
      // Check if user removed it while processing previous
      const currentQueue = await new Promise<QueueItem[]>(resolve => {
         setQueue(q => { resolve(q); return q; });
      });
      if (!currentQueue.find(i => i.id === item.id)) continue;

      // Update status to processing
      setQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'processing', errorMsg: undefined } : i));

      try {
        // Create fresh client instance for each request to ensure valid key
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        
        // Get base64 and auto-detected aspect ratio
        const { base64, aspectRatio } = await prepareImageForGenAI(item.file);
        
        // Construct prompt
        const specificInstruction = item.customPrompt || "";
        const finalPrompt = `${globalPrompt} ${specificInstruction}`;

        const response = await ai.models.generateContent({
          model: 'gemini-3-pro-image-preview',
          contents: {
            parts: [
              {
                inlineData: {
                  data: base64,
                  mimeType: item.file.type || 'image/png'
                }
              },
              {
                text: finalPrompt
              }
            ]
          },
          config: {
            imageConfig: {
              imageSize: '4K', // CRITICAL for text legibility
              aspectRatio: aspectRatio // Auto-detected from source image
            }
          }
        });

        // Extract image
        let imageUrl = null;
        if (response.candidates?.[0]?.content?.parts) {
          for (const part of response.candidates[0].content.parts) {
            if (part.inlineData) {
              imageUrl = `data:image/png;base64,${part.inlineData.data}`;
              break;
            }
          }
        }

        if (imageUrl) {
          setQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'success', resultUrl: imageUrl } : i));
        } else {
          throw new Error("No image generated.");
        }

      } catch (err: any) {
        console.error("Error processing image:", err);
        let errorMsg = "生成失敗";
        
        if (err.message?.includes("Requested entity was not found")) {
          setHasKey(false);
          setIsProcessing(false);
          // If the key is invalid, we stop processing the queue and prompt user to select key again.
          // Since we set hasKey(false), the UI will switch to the "Connect API Key" screen.
          return;
        }

        if (err.message?.includes("Safety")) errorMsg = "觸發安全限制";
        if (err.message?.includes("429")) errorMsg = "請求過於頻繁，請稍候";
        
        setQueue(prev => prev.map(i => i.id === item.id ? { ...i, status: 'error', errorMsg } : i));
      }
    }

    setIsProcessing(false);
  };

  const cancelProcessing = () => {
    // This effectively stops the loop on the next iteration
    setIsProcessing(false);
  };

  if (!hasKey) {
    return (
      <div style={{
        display: 'flex', 
        flexDirection: 'column', 
        alignItems: 'center', 
        justifyContent: 'center', 
        height: '100vh',
        gap: '20px',
        textAlign: 'center'
      }}>
        <div style={{ padding: '20px', background: 'var(--surface-color)', borderRadius: '12px', border: '1px solid var(--border-color)', maxWidth: '400px' }}>
          <ImageIcon size={48} color="var(--primary-color)" style={{ marginBottom: '16px' }} />
          <h2>歡迎使用 Puti-AI 4K 批次修復工具</h2>
          <p style={{ color: '#aaa', marginBottom: '24px' }}>
            為了使用 Gemini 3 Pro (Nano Banana Pro) 生成高品質 4K 圖片，您需要連接付費 API 金鑰。
          </p>
          <button className="btn" onClick={handleSelectKey}>
            連接 API 金鑰
          </button>
          <div style={{ marginTop: '16px', fontSize: '0.8rem' }}>
            <a href="https://ai.google.dev/gemini-api/docs/billing" target="_blank" style={{ color: 'var(--accent-color)' }}>
              計費說明文件
            </a>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-container" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1 }}>
        {/* Header */}
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '30px', borderBottom: '1px solid var(--border-color)', paddingBottom: '20px' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.5rem', display: 'flex', alignItems: 'center', gap: '10px' }}>
              <ImageIcon /> Puti-AI 圖片批次修正繁中字
            </h1>
            <p style={{ margin: '5px 0 0 0', color: '#888', fontSize: '0.9rem' }}>
              高清繁體中文文字修復
            </p>
          </div>
          <div style={{ display: 'flex', gap: '10px' }}>
            <button className="btn btn-secondary" onClick={() => setQueue([])} disabled={isProcessing || queue.length === 0}>
              <Trash2 size={16} /> 全部清除
            </button>
          </div>
        </header>

        <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', gap: '30px' }}>
          
          {/* Left Sidebar: Controls */}
          <div style={{ background: 'var(--surface-color)', padding: '20px', borderRadius: '12px', height: 'fit-content', border: '1px solid var(--border-color)' }}>
            <h3 style={{ marginTop: 0, display: 'flex', alignItems: 'center', gap: '8px' }}>
              <Settings size={18} /> 全域設定
            </h3>
            
            <div className="input-group">
              <label>通用提示詞 (建議保留英文以維持品質)</label>
              <textarea 
                rows={5}
                value={globalPrompt}
                onChange={(e) => setGlobalPrompt(e.target.value)}
                placeholder="套用到所有圖片的指令..."
                style={{ resize: 'vertical' }}
              />
            </div>

            <div className="input-group" style={{ marginTop: '20px' }}>
              <button 
                className="btn" 
                onClick={processQueue} 
                disabled={isProcessing || queue.filter(i => i.status === 'idle' || i.status === 'error').length === 0}
                style={{ justifyContent: 'center', background: isProcessing ? '#444' : 'var(--accent-color)' }}
              >
                {isProcessing ? (
                  <> <Loader2 className="spin" size={20} /> 處理佇列中... </>
                ) : (
                  <> <Play size={20} /> 開始批次處理 </>
                )}
              </button>
              {isProcessing && (
                <button className="btn btn-secondary" onClick={cancelProcessing} style={{ marginTop: '10px', justifyContent: 'center' }}>
                  停止
                </button>
              )}
            </div>
            
            <div style={{ marginTop: '20px', padding: '15px', background: 'rgba(76, 141, 246, 0.1)', borderRadius: '8px', fontSize: '0.85rem', color: '#a8c7fa' }}>
              <strong>Puti-AI 專業提示：</strong> 
              <ul style={{ paddingLeft: '20px', margin: '10px 0 0 0' }}>
                <li style={{ marginBottom: '5px' }}>系統會自動偵測並維持原圖長寬比。</li>
                <li>所有圖片均強制以 <strong>4K 解析度</strong> 處理，確保繁體中文字元正確顯示。</li>
                <li>每張圖片生成約需 10-20 秒。</li>
              </ul>
            </div>
          </div>

          {/* Right Area: Upload & List */}
          <div>
            {/* Upload Area */}
            <div 
              onClick={() => fileInputRef.current?.click()}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              style={{
                border: `2px dashed ${dragActive ? 'var(--accent-color)' : 'var(--border-color)'}`,
                background: dragActive ? 'rgba(76, 141, 246, 0.05)' : 'transparent',
                borderRadius: '12px',
                padding: '40px',
                textAlign: 'center',
                cursor: 'pointer',
                marginBottom: '30px',
                transition: 'all 0.2s'
              }}
            >
              <input 
                type="file" 
                multiple 
                accept="image/*" 
                ref={fileInputRef} 
                style={{ display: 'none' }} 
                onChange={(e) => handleFiles(e.target.files)} 
              />
              <Upload size={32} color={dragActive ? "var(--accent-color)" : "#666"} />
              <p style={{ margin: '10px 0 5px 0', fontSize: '1.1rem', fontWeight: 500 }}>
                將圖片拖放到此處，或點擊上傳
              </p>
              <p style={{ margin: 0, color: '#666', fontSize: '0.9rem' }}>
                支援批次上傳。圖片將被加入 Puti-AI 工作佇列。
              </p>
            </div>

            {/* Queue List */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
              {queue.length === 0 && (
                <div style={{ textAlign: 'center', padding: '40px', color: '#555' }}>
                  工作佇列目前是空的
                </div>
              )}

              {queue.map((item, index) => (
                <div key={item.id} style={{ 
                  background: 'var(--surface-color)', 
                  borderRadius: '12px', 
                  border: '1px solid var(--border-color)',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column'
                }}>
                  {/* Card Header */}
                  <div style={{ 
                    padding: '15px', 
                    borderBottom: '1px solid var(--border-color)', 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center',
                    background: 'rgba(255,255,255,0.02)'
                  }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      <span style={{ 
                        background: '#333', 
                        width: '24px', 
                        height: '24px', 
                        borderRadius: '50%', 
                        display: 'flex', 
                        alignItems: 'center', 
                        justifyContent: 'center',
                        fontSize: '0.8rem',
                        fontWeight: 'bold'
                      }}>{index + 1}</span>
                      <span style={{ fontSize: '0.9rem', color: '#eee', maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.file.name}
                      </span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                      {item.status === 'processing' && <span style={{ color: 'var(--primary-color)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '5px' }}><Loader2 className="spin" size={14} /> 處理中 (4K)</span>}
                      {item.status === 'success' && <span style={{ color: 'var(--success-color)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '5px' }}><Check size={14} /> 完成</span>}
                      {item.status === 'error' && <span style={{ color: 'var(--error-color)', fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '5px' }}><AlertCircle size={14} /> 錯誤</span>}
                      {item.status === 'idle' && <span style={{ color: '#666', fontSize: '0.85rem' }}>已排隊</span>}
                      
                      <button 
                        onClick={() => removeItem(item.id)}
                        style={{ background: 'none', border: 'none', color: '#666', cursor: 'pointer', padding: '5px' }}
                      >
                        <X size={16} />
                      </button>
                    </div>
                  </div>

                  {/* Card Content */}
                  <div style={{ padding: '20px', display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: '20px', alignItems: 'start' }}>
                    {/* Source */}
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '8px' }}>原始圖片</div>
                      <div style={{ 
                        aspectRatio: item.status === 'success' ? 'auto' : '1', 
                        background: '#000', 
                        borderRadius: '8px', 
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        maxHeight: '200px'
                      }}>
                        <img src={item.previewUrl} style={{ maxWidth: '100%', maxHeight: '200px', objectFit: 'contain' }} />
                      </div>
                    </div>

                    {/* Prompt Config */}
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '8px' }}>個別微調指令 (選填)</div>
                      <textarea 
                        placeholder="針對此圖片的特定文字覆蓋 (例如：將文字替換為 '繁榮昌盛')..."
                        value={item.customPrompt || ''}
                        onChange={(e) => updateItemPrompt(item.id, e.target.value)}
                        disabled={item.status === 'processing' || item.status === 'success'}
                        rows={4}
                        style={{ width: '100%', fontSize: '0.9rem' }}
                      />
                      {item.errorMsg && (
                         <div style={{ marginTop: '10px', color: 'var(--error-color)', fontSize: '0.85rem' }}>
                           失敗原因： {item.errorMsg}
                         </div>
                      )}
                    </div>

                    {/* Result */}
                    <div>
                      <div style={{ fontSize: '0.8rem', color: '#888', marginBottom: '8px' }}>Puti-AI 處理結果 (4K)</div>
                      {item.resultUrl ? (
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                          <div style={{ 
                             background: '#000', 
                             borderRadius: '8px', 
                             overflow: 'hidden',
                             display: 'flex',
                             alignItems: 'center',
                             justifyContent: 'center',
                             maxHeight: '200px'
                          }}>
                            <img src={item.resultUrl} style={{ maxWidth: '100%', maxHeight: '200px', objectFit: 'contain' }} />
                          </div>
                          <a 
                            href={item.resultUrl} 
                            download={`Puti-AI-${item.file.name.split('.')[0]}.png`}
                            className="btn" 
                            style={{ width: '100%', justifyContent: 'center', padding: '8px', fontSize: '0.85rem' }}
                          >
                            <Download size={16} /> 下載 4K 圖檔
                          </a>
                        </div>
                      ) : (
                        <div style={{ 
                          height: '150px', 
                          border: '1px dashed #444', 
                          borderRadius: '8px', 
                          display: 'flex', 
                          alignItems: 'center', 
                          justifyContent: 'center',
                          color: '#444',
                          fontSize: '0.8rem',
                          fontStyle: 'italic'
                        }}>
                          等待處理中...
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      
      {/* Footer */}
      <footer style={{ 
        marginTop: '60px', 
        paddingTop: '20px', 
        borderTop: '1px solid var(--border-color)', 
        textAlign: 'center', 
        color: '#666',
        fontSize: '0.85rem',
        lineHeight: '1.6'
      }}>
        <div>👨‍🏫 作者為 Puti-AI黃朝榮老師</div>
        <div>©️ 請尊重著作權，延伸改做請徵詢同意，發布時標註原作者。</div>
        <div>🚫 不得商用。</div>
        <div style={{ marginTop: '8px' }}>
          🔗 請點我看更多: <a href="https://padlet.com/clongwh/puti_ai_tools" target="_blank" style={{ color: 'var(--accent-color)', textDecoration: 'none' }}>Puti-AI教學工具庫</a>
        </div>
      </footer>
      
      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { 100% { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
};

const root = createRoot(document.getElementById('root')!);
root.render(<App />);