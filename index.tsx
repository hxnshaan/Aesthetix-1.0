import React, { useState, useRef, useEffect, useMemo } from 'react';
import ReactDOM from 'react-dom/client';
import { GoogleGenAI } from "@google/genai";

const API_KEY = process.env.API_KEY;
const MAX_HISTORY = 20;

type BasicFilters = {
  brightness: number;
  contrast: number;
  saturate: number;
  sepia: number;
  exposure: number;
  highlights: number;
  shadows: number;
  temperature: number;
  vibrance: number;
  sharpen: number;
  dehaze: number;
  grain: number;
};

type HSLColor = { h: number; s: number; l: number };
type HSLFilters = {
    red: HSLColor;
    orange: HSLColor;
    yellow: HSLColor;
    green: HSLColor;
    aqua: HSLColor;
    blue: HSLColor;
    purple: HSLColor;
    magenta: HSLColor;
};

type EditorState = {
    filters: BasicFilters;
    hsl: HSLFilters;
    editedImageSrc: string | null;
    maskSrc: string | null;
    isMaskInverted: boolean;
};

type HistoryState = {
    stack: EditorState[];
    index: number;
}

type Theme = 'light' | 'dark' | 'mono';
type CustomPreset = { name: string; filters: BasicFilters; hsl: HSLFilters };
type DownloadOptions = { format: 'image/png' | 'image/jpeg', quality: number };
type Transform = { zoom: number; pan: { x: number; y: number } };
type Preview = { active: boolean; src: string | null; width: number; height: number; };

const initialFilters: BasicFilters = {
    brightness: 100, contrast: 100, saturate: 100, sepia: 0,
    exposure: 0, highlights: 0, shadows: 0,
    temperature: 0, vibrance: 0, sharpen: 0, dehaze: 0, grain: 0,
};

const initialHSL: HSLFilters = Object.fromEntries(
    ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'magenta'].map(c => [c, { h: 0, s: 0, l: 0 }])
) as HSLFilters;

const initialState: EditorState = {
    filters: initialFilters,
    hsl: initialHSL,
    editedImageSrc: null,
    maskSrc: null,
    isMaskInverted: false,
};

const MorphingLoader = () => (
    <svg className="morphing-loader" viewBox="0 0 100 100">
        <path d="M 50,10 A 40,40 0 1 1 50,90 A 40,40 0 1 1 50,10 Z" />
    </svg>
);

const AccordionSection = ({ title, id, children, activeAccordion, setActiveAccordion }) => (
    <div className="tool-section">
        <h3 onClick={() => setActiveAccordion(activeAccordion === id ? null : id)}>
            <span>{title}</span>
            <span className={`material-symbols-outlined expand-icon ${activeAccordion === id ? 'expanded': ''}`}>expand_more</span>
        </h3>
        <div className={`accordion-content ${activeAccordion === id ? 'open' : ''}`}>
            {children}
        </div>
    </div>
);
  
const WavySlider = ({ label, unit, value, min, max, onChange, onCommit, onInteractionStart, disabled }) => {
    const [isDragging, setIsDragging] = useState(false);

    const handleStart = () => {
        if (disabled) return;
        setIsDragging(true);
        if (onInteractionStart) onInteractionStart();
    };

    const handleEnd = () => {
        if (isDragging) {
            setIsDragging(false);
            if (onCommit) onCommit();
        }
    };
    
    useEffect(() => {
        // Add listeners to the window to catch mouseup/touchend outside the slider itself.
        window.addEventListener('mouseup', handleEnd);
        window.addEventListener('touchend', handleEnd);
        return () => {
            window.removeEventListener('mouseup', handleEnd);
            window.removeEventListener('touchend', handleEnd);
        };
    }, [isDragging]); // Only re-attach if dragging state changes

    const percentage = ((value - min) / (max - min)) * 100;
    const containerClasses = `wavy-slider-container ${isDragging ? 'dragging' : ''} ${disabled ? 'disabled' : ''}`;

    return (
        <div className={containerClasses}>
            <label>
                <span>{label}</span>
                <span>{value}{unit}</span>
            </label>
            <div className="wavy-slider-track-wrapper">
                 <div className="wavy-slider-fill" style={{ width: `${percentage}%` }}></div>
                 <input
                    type="range" min={min} max={max} value={value}
                    onChange={onChange}
                    onMouseDown={handleStart}
                    onTouchStart={handleStart}
                    disabled={disabled} aria-label={label}
                />
            </div>
        </div>
    );
};


const App = () => {
  const [originalImageSrc, setOriginalImageSrc] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryState>({ stack: [initialState], index: 0 });
  
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [loadingMessage, setLoadingMessage] = useState<string>('');
  const [activeAccordion, setActiveAccordion] = useState<string | null>('basic');
  const [compositionAdvice, setCompositionAdvice] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>('light');
  const [showDownloadModal, setShowDownloadModal] = useState<boolean>(false);
  const [downloadOptions, setDownloadOptions] = useState<DownloadOptions>({ format: 'image/png', quality: 92 });
  const [showGenFillModal, setShowGenFillModal] = useState<boolean>(false);
  const [genFillPrompt, setGenFillPrompt] = useState<string>('');
  const [customPresets, setCustomPresets] = useState<CustomPreset[]>([]);
  const [showMenu, setShowMenu] = useState(false);
  const [isPeeking, setIsPeeking] = useState(false);
  const [isSideBySide, setIsSideBySide] = useState(false);
  const [transform, setTransform] = useState<Transform>({ zoom: 1, pan: { x: 0, y: 0 } });
  const [showBetaMessage, setShowBetaMessage] = useState<boolean>(false);
  const [isBrushActive, setIsBrushActive] = useState(false);
  const [brushSize, setBrushSize] = useState(30);
  const [isErasing, setIsErasing] = useState(false);

  // State for live, non-laggy slider previews
  const [liveState, setLiveState] = useState<EditorState | null>(null);
  const [preview, setPreview] = useState<Preview>({ active: false, src: null, width: 0, height: 0 });

  const currentState = history.stack[history.index];
  const displayState = liveState || currentState; // Use live state for UI if available
  const canUndo = history.index > 0;
  const canRedo = history.index < history.stack.length - 1;
  
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const canvasWrapperRef = useRef<HTMLDivElement>(null);
  const panState = useRef({ isPanning: false, startX: 0, startY: 0 });
  const drawingState = useRef({ isDrawing: false, lastX: 0, lastY: 0 });
  const longPressTimer = useRef<number | null>(null);

  const ai = new GoogleGenAI({ apiKey: API_KEY });
  
  const commitChange = (updater: (prevState: EditorState) => EditorState, overwrite = false) => {
    setHistory(prevHistoryState => {
        const { stack, index } = prevHistoryState;
        
        // Base the new state on the current state in history
        const baseState = stack[index];
        const newState = updater(baseState);

        // Slice history based on current index, ready for the new state
        const newHistoryBase = overwrite ? stack.slice(0, index) : stack.slice(0, index + 1);
        
        let newStack = [...newHistoryBase, newState];

        // Manage history length
        if (newStack.length > MAX_HISTORY) {
            newStack.shift();
        }

        return {
            stack: newStack,
            index: newStack.length - 1, // New index is always the last item
        };
    });
  };
  
  const undo = () => {
    if (canUndo) {
        setHistory(h => ({ ...h, index: h.index - 1 }));
    }
  };
  const redo = () => {
    if (canRedo) {
        setHistory(h => ({ ...h, index: Math.min(h.stack.length - 1, h.index + 1) }));
    }
  };

  useEffect(() => {
    const savedPresets = localStorage.getItem('photoEditorPresets');
    if (savedPresets) setCustomPresets(JSON.parse(savedPresets));
    
    const hasSeenBetaMessage = localStorage.getItem('hasSeenBetaMessage');
    if (!hasSeenBetaMessage) setShowBetaMessage(true);
  }, []);

  useEffect(() => { document.body.className = `${theme}-theme`; }, [theme]);
  
  const mainFilterStyle = useMemo(() => {
    if (!currentState) return '';
    const { brightness, contrast, saturate, sepia, exposure } = currentState.filters;
    const finalBrightness = Math.max(0, brightness + exposure);
    return `brightness(${finalBrightness}%) contrast(${contrast}%) saturate(${saturate}%) sepia(${sepia}%)`;
  }, [currentState?.filters]);
  
  const liveFilterStyle = useMemo(() => {
    if (!displayState) return '';
    const { brightness, contrast, saturate, sepia, exposure } = displayState.filters;
    const finalBrightness = Math.max(0, brightness + exposure);
    return `brightness(${finalBrightness}%) contrast(${contrast}%) saturate(${saturate}%) sepia(${sepia}%)`;
  }, [displayState?.filters]);


  useEffect(() => {
    drawCanvas();
  }, [currentState, transform]);

  useEffect(() => {
    const maskCanvas = maskCanvasRef.current;
    const ctx = maskCanvas?.getContext('2d');
    if (isBrushActive && maskCanvas && ctx) {
      ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
      if (currentState.maskSrc) {
        const img = new Image();
        img.src = currentState.maskSrc;
        img.onload = () => {
          ctx.drawImage(img, 0, 0);
        };
      }
    }
  }, [isBrushActive, currentState.maskSrc]);
  

  const drawCanvas = () => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!canvas || !ctx || !currentState.editedImageSrc) return;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = currentState.editedImageSrc;
    img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        if(maskCanvasRef.current){
          maskCanvasRef.current.width = img.naturalWidth;
          maskCanvasRef.current.height = img.naturalHeight;
        }
        
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
        
        if (currentState.maskSrc && !isBrushActive) {
            const maskImg = new Image();
            maskImg.crossOrigin = 'anonymous';
            maskImg.src = currentState.maskSrc;
            maskImg.onload = () => {
                ctx.globalCompositeOperation = 'source-atop';
                ctx.fillStyle = currentState.isMaskInverted ? 'rgba(0, 0, 255, 0.4)' : 'rgba(255, 0, 0, 0.4)';
                ctx.drawImage(maskImg, 0, 0, canvas.width, canvas.height);
                ctx.fillRect(0,0, canvas.width, canvas.height);
                ctx.globalCompositeOperation = 'source-over';
            };
        }
    };
  };

  const handleInteractionStart = () => {
    const canvas = canvasRef.current;
    if (preview.active || !canvas || !originalImageSrc) return;

    // Capture dimensions SYNCHRONOUSLY before any async work
    const { clientWidth, clientHeight } = canvas;
    
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = originalImageSrc;
    img.onload = () => {
        const tempCanvas = document.createElement('canvas');
        const ctx = tempCanvas.getContext('2d');
        if (!ctx) return;
        const MAX_WIDTH = 400; // Create a small preview
        const scale = MAX_WIDTH / img.naturalWidth;
        tempCanvas.width = MAX_WIDTH;
        tempCanvas.height = img.naturalHeight * scale;
        ctx.drawImage(img, 0, 0, tempCanvas.width, tempCanvas.height);

        // Set all preview state atomically
        setPreview({
            active: true,
            src: tempCanvas.toDataURL(),
            width: clientWidth,
            height: clientHeight,
        });
    };
  };

  const handleLiveUpdate = (updater: (draft: EditorState) => EditorState) => {
    setLiveState(prevLiveState => {
        const baseState = prevLiveState || currentState;
        return updater(baseState);
    });
  };
  
  const handleCommit = () => {
    setLiveState(currentLiveState => {
        if (currentLiveState) {
            // commitChange is robust and doesn't rely on stale closures.
            // This is safe to call from here.
            commitChange(() => currentLiveState);
        }
        return null; // Always reset live state after commit
    });

    // Defer turning off preview to allow CSS transition on main canvas filter
    setTimeout(() => setPreview(p => ({...p, active: false})), 50);
  };

  const handleFilterLiveChange = (filterName: keyof BasicFilters, value: string) => {
    handleLiveUpdate(prev => ({
        ...prev,
        filters: { ...prev.filters, [filterName]: parseInt(value, 10) },
    }));
  };

  const handleHslLiveChange = (color: keyof HSLFilters, channel: keyof HSLColor, value: string) => {
    handleLiveUpdate(prev => ({
        ...prev,
        hsl: { ...prev.hsl, [color]: { ...prev.hsl[color], [channel]: parseInt(value, 10) } }
    }));
  };

  const handleCloseBetaMessage = () => {
    setShowBetaMessage(false);
    localStorage.setItem('hasSeenBetaMessage', 'true');
  };
  
  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const file = e.target.files[0];
      if (file.type.toLowerCase().includes('xmp')) {
          alert('XMP preset files are not supported. You can save and load your own presets using the built-in preset manager.');
          return;
      }
      if (!file.type.startsWith('image/')) {
          alert('This file type may not be supported. Please use standard image formats like JPEG, PNG, or WEBP.');
          return;
      }
      const reader = new FileReader();
      reader.onload = (event) => {
        const src = event.target?.result as string;
        setOriginalImageSrc(src);
        const newInitialState = { ...initialState, editedImageSrc: src };
        setHistory({ stack: [newInitialState], index: 0 });
        setTransform({ zoom: 1, pan: { x: 0, y: 0 } });
        setShowMenu(false);
      };
      reader.readAsDataURL(file);
    }
  };
  
  const handleReset = () => {
    if(originalImageSrc) {
      const newInitialState = { ...initialState, editedImageSrc: originalImageSrc };
      setHistory({ stack: [newInitialState], index: 0 });
      setTransform({ zoom: 1, pan: { x: 0, y: 0 } });
      setShowMenu(false);
    }
  }
  
  const getCanvasAsBase64 = (): string | null => {
      if(!currentState.editedImageSrc) return null;
      const freshCanvas = document.createElement('canvas');
      const ctx = freshCanvas.getContext('2d');
      const img = new Image();
      img.src = currentState.editedImageSrc;
      freshCanvas.width = img.naturalWidth;
      freshCanvas.height = img.naturalHeight;
      if (ctx) {
        ctx.filter = mainFilterStyle;
        ctx.drawImage(img, 0, 0);
      }
      return freshCanvas.toDataURL('image/png').split(',')[1];
  }

  const applyAiAction = async (prompt: string, loadingText: string, options: { isTextResponse?: boolean, mask?: string | null } = {}): Promise<string | null> => {
    if (!originalImageSrc) return null;
    setIsLoading(true);
    setLoadingMessage(loadingText);
    try {
        const imageB64 = getCanvasAsBase64();
        if(!imageB64) throw new Error("Could not get image data.");
        
        const imagePart = { inlineData: { mimeType: 'image/png', data: imageB64 }};
        let finalPrompt = prompt;
        const parts: any[] = [{text: finalPrompt}, imagePart];
        
        const maskToUse = options.mask !== undefined ? options.mask : currentState.maskSrc;

        if (maskToUse) {
            const maskB64 = maskToUse.split(',')[1];
            const maskPart = { inlineData: { mimeType: 'image/png', data: maskB64 } };
            parts.push(maskPart);
            finalPrompt += currentState.isMaskInverted 
                ? " You have been provided a second image which is a mask. Apply the effect ONLY to the area corresponding to the BLACK region of the mask." 
                : " You have been provided a second image which is a mask. Apply the effect ONLY to the area corresponding to the WHITE region of the mask.";
            parts[0] = { text: finalPrompt }; 
        }
        
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: [{ parts }],
        });

        if (options.isTextResponse) {
            return response.text;
        }

        const imgPart = response.candidates?.[0]?.content?.parts?.find(p => 'inlineData' in p);

        if (imgPart && 'inlineData' in imgPart && imgPart.inlineData) {
            return `data:${imgPart.inlineData.mimeType};base64,${imgPart.inlineData.data}`;
        }
        
        throw new Error(`AI did not return valid image data. ${response.text ? `Response: ${response.text}` : ''}`);
      
    } catch (error) {
      console.error(error);
      alert(`An error occurred: ${error.message}`);
      return null;
    } finally {
      setIsLoading(false);
      setLoadingMessage('');
    }
  };

  const aiImageToImage = async (prompt: string, loading: string, mask?: string | null) => {
    const result = await applyAiAction(prompt, loading, { mask });
    if(result) commitChange(prev => ({...prev, editedImageSrc: result, maskSrc: null}));
  }
  
  const aiMasking = async (prompt: string, loading: string) => {
    const result = await applyAiAction(prompt, loading);
    if (result) commitChange(prev => ({ ...prev, maskSrc: result }));
  }
  
  const handleGenFill = async () => {
      if (!genFillPrompt) return;
      setShowGenFillModal(false);
      const prompt = `Based on the user prompt "${genFillPrompt}", seamlessly replace the masked area in the image.`;
      await aiImageToImage(prompt, "Generative Filling...");
      setGenFillPrompt('');
  }

  const handleRemoveSubject = async () => {
    if (!currentState.maskSrc) return;
    const prompt = `The user has provided a mask. Your task is to completely remove the subject within the masked (white) area and intelligently fill the resulting empty space with a realistic background that seamlessly matches the surrounding image.`;
    await aiImageToImage(prompt, "Removing Subject...");
  };

  const handleDownload = () => {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || !currentState.editedImageSrc) return;

    const img = new Image();
    img.crossOrigin = "anonymous";
    img.src = currentState.editedImageSrc;
    img.onload = () => {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        ctx.filter = mainFilterStyle;
        ctx.drawImage(img, 0, 0);
        
        const link = document.createElement('a');
        link.download = `edited-image.${downloadOptions.format.split('/')[1]}`;
        link.href = canvas.toDataURL(downloadOptions.format, downloadOptions.quality / 100);
        link.click();
        setShowDownloadModal(false);
        setShowMenu(false);
    };
  };

  const applyBuiltInPreset = (preset: 'vintage' | 'cinematic') => {
      commitChange(prev => {
          let newFilters = { ...prev.filters };
          let newHsl = { ...prev.hsl };
          if(preset === 'vintage') {
              newFilters = { ...newFilters, sepia: 25, brightness: 110, contrast: 110, saturate: 90 };
          } else if (preset === 'cinematic') {
              newFilters = { ...newFilters, contrast: 120, saturate: 85 };
              newHsl = { ...newHsl, blue: {...newHsl.blue, l: -10, s: -15}, orange: {...newHsl.orange, l: 5, s: 5} };
          }
          return { ...prev, filters: newFilters, hsl: newHsl };
      });
  }
  
  const saveCustomPreset = () => {
      const name = prompt("Enter a name for your preset:");
      if (name) {
          const newPreset = { name, filters: currentState.filters, hsl: currentState.hsl };
          const updatedPresets = [...customPresets, newPreset];
          setCustomPresets(updatedPresets);
          localStorage.setItem('photoEditorPresets', JSON.stringify(updatedPresets));
      }
  }
  
  const loadCustomPreset = (preset: CustomPreset) => {
      commitChange(prev => ({...prev, filters: preset.filters, hsl: preset.hsl}));
  }
  
  const deleteCustomPreset = (index: number) => {
      const updatedPresets = customPresets.filter((_, i) => i !== index);
      setCustomPresets(updatedPresets);
      localStorage.setItem('photoEditorPresets', JSON.stringify(updatedPresets));
  }

  const generateGradientMask = (type: 'linear' | 'radial') => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = canvas.width;
      tempCanvas.height = canvas.height;
      const ctx = tempCanvas.getContext('2d');
      if (!ctx) return;

      let gradient;
      if (type === 'linear') {
          gradient = ctx.createLinearGradient(0, 0, 0, tempCanvas.height);
          gradient.addColorStop(0, 'white');
          gradient.addColorStop(1, 'black');
      } else { // radial
          const centerX = tempCanvas.width / 2;
          const centerY = tempCanvas.height / 2;
          const radius = Math.max(centerX, centerY);
          gradient = ctx.createRadialGradient(centerX, centerY, 0, centerX, centerY, radius);
          gradient.addColorStop(0, 'white');
          gradient.addColorStop(1, 'black');
      }
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
      commitChange(prev => ({...prev, maskSrc: tempCanvas.toDataURL()}));
  }

    const getCanvasCoordinates = (e: MouseEvent | TouchEvent | React.MouseEvent | React.TouchEvent) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;

        const rect = canvas.getBoundingClientRect();
        const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
        const clientY = 'touches' in e ? e.touches[0].clientY : e.clientY;

        const x = (clientX - rect.left) / transform.zoom;
        const y = (clientY - rect.top) / transform.zoom;

        return { x, y };
    };

    const startDrawing = (e: React.MouseEvent | React.TouchEvent) => {
        const coords = getCanvasCoordinates(e.nativeEvent);
        if (!coords) return;
        const ctx = maskCanvasRef.current?.getContext('2d');
        if (!ctx) return;
        drawingState.current.isDrawing = true;
        ctx.beginPath();
        ctx.moveTo(coords.x, coords.y);
    };

    const draw = (e: React.MouseEvent | React.TouchEvent) => {
        if (!drawingState.current.isDrawing) return;
        const coords = getCanvasCoordinates(e.nativeEvent);
        if (!coords) return;
        const ctx = maskCanvasRef.current?.getContext('2d');
        if (!ctx) return;

        ctx.lineWidth = brushSize;
        ctx.lineCap = 'round';
        ctx.strokeStyle = 'white';
        ctx.globalCompositeOperation = isErasing ? 'destination-out' : 'source-over';
        ctx.lineTo(coords.x, coords.y);
        ctx.stroke();
    };

    const stopDrawing = () => {
        drawingState.current.isDrawing = false;
        const maskCanvas = maskCanvasRef.current;
        if (maskCanvas) {
            commitChange(prev => ({ ...prev, maskSrc: maskCanvas.toDataURL() }), true);
        }
    };
    
    const handleCanvasWrapperMouseUp = (e: React.MouseEvent) => {
        if (drawingState.current.isDrawing) stopDrawing();
        if (panState.current.isPanning) {
            panState.current.isPanning = false;
            if (canvasWrapperRef.current) canvasWrapperRef.current.style.cursor = 'grab';
        }
    };

    const handleCanvasWrapperMouseMove = (e: React.MouseEvent) => {
        if (drawingState.current.isDrawing) draw(e);
        else if (panState.current.isPanning) {
            const newX = e.clientX - panState.current.startX;
            const newY = e.clientY - panState.current.startY;
            setTransform(t => ({...t, pan: {x: newX, y: newY}}));
        }
    };

    const handleCanvasWrapperMouseDown = (e: React.MouseEvent) => {
        if (isBrushActive) {
            startDrawing(e);
        } else if (e.button === 1) { // Middle mouse button for panning
            panState.current = { isPanning: true, startX: e.clientX - transform.pan.x, startY: e.clientY - transform.pan.y };
            e.preventDefault();
            if(canvasWrapperRef.current) canvasWrapperRef.current.style.cursor = 'grabbing';
        }
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        const delta = e.deltaY * -0.005;
        setTransform(t => ({...t, zoom: Math.min(Math.max(0.2, t.zoom + delta), 5)}));
    };
    
    const handleDoubleClick = () => {
        setTransform(t => ({...t, zoom: t.zoom > 1.5 ? 1 : 2}));
    }
    
    const handleBeforeAfterPointerDown = () => {
        longPressTimer.current = window.setTimeout(() => {
            setIsPeeking(true);
            longPressTimer.current = null;
        }, 250);
    };

    const handleBeforeAfterPointerUp = () => {
        if (longPressTimer.current) {
            clearTimeout(longPressTimer.current);
            longPressTimer.current = null;
            setIsSideBySide(prev => !prev);
        } else {
            setIsPeeking(false);
        }
    };

  return (
    <div className="app-container">
      {showBetaMessage && (
        <div className="modal-overlay" onClick={handleCloseBetaMessage}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <h3>Welcome!</h3>
                <p>This software is in beta. Thank you for trying out our new features!</p>
                <div className="ai-studio-notice">
                    <span className="material-symbols-outlined">auto_awesome</span>
                     Assisted by Google AI Studio
                </div>
                <button className="btn btn-primary" onClick={handleCloseBetaMessage}>Get Started</button>
            </div>
        </div>
      )}
      {isLoading && (
        <div className="loading-overlay">
          <MorphingLoader />
          <p>{loadingMessage}</p>
        </div>
      )}
      { (compositionAdvice || showDownloadModal || showGenFillModal) && (
        <div className="modal-overlay" onClick={() => {
            setCompositionAdvice(null);
            setShowDownloadModal(false);
            setShowGenFillModal(false);
        }}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                {compositionAdvice && <>
                    <h3>Composition Advice</h3>
                    <p>{compositionAdvice}</p>
                    <button className="btn btn-primary" onClick={() => setCompositionAdvice(null)}>Close</button>
                </>}
                {showDownloadModal && <>
                    <h3>Export Image</h3>
                    <div className="download-options">
                        <label>Format</label>
                        <select value={downloadOptions.format} onChange={e => setDownloadOptions(d => ({...d, format: e.target.value as any}))}>
                            <option value="image/png">PNG</option>
                            <option value="image/jpeg">JPEG</option>
                        </select>
                        {downloadOptions.format === 'image/jpeg' && <>
                            <WavySlider 
                                label="Quality"
                                unit=""
                                value={downloadOptions.quality}
                                min={1}
                                max={100}
                                onChange={e => setDownloadOptions(d => ({...d, quality: parseInt(e.target.value)}))}
                                onCommit={()=>{}}
                                onInteractionStart={()=>{}}
                                disabled={false}
                            />
                        </>}
                    </div>
                    <button className="btn btn-primary" onClick={handleDownload}>Export</button>
                </>}
                {showGenFillModal && <>
                    <h3>Generative Fill</h3>
                    <p>Enter a prompt to fill the masked area.</p>
                    <input type="text" className="text-input" value={genFillPrompt} onChange={e => setGenFillPrompt(e.target.value)} placeholder="e.g., a field of flowers"/>
                    <button className="btn btn-primary" onClick={handleGenFill} disabled={!genFillPrompt}>Generate</button>
                </>}
            </div>
        </div>
      )}
      <header className="app-header">
        <h1>aesthetiX <span className="by-shaan">by shaan</span></h1>
        <div className="header-controls">
            <div className="theme-switcher">
                <button title="Light Mode" className={`theme-btn ${theme === 'light' ? 'active' : ''}`} onClick={() => setTheme('light')}><span className="material-symbols-outlined">light_mode</span></button>
                <button title="Dark Mode" className={`theme-btn ${theme === 'dark' ? 'active' : ''}`} onClick={() => setTheme('dark')}><span className="material-symbols-outlined">dark_mode</span></button>
                <button title="Monochrome Mode" className={`theme-btn ${theme === 'mono' ? 'active' : ''}`} onClick={() => setTheme('mono')}><span className="material-symbols-outlined">contrast</span></button>
            </div>
            <div className="main-menu">
                <button className="menu-toggle" onClick={() => setShowMenu(!showMenu)}>
                    <span className="material-symbols-outlined">more_vert</span>
                </button>
                {showMenu && (
                    <div className="menu-dropdown">
                        <button onClick={() => { fileInputRef.current?.click(); }}><span className="material-symbols-outlined">upload_file</span> Upload</button>
                        <button onClick={() => { setShowDownloadModal(true); setShowMenu(false);}} disabled={!originalImageSrc}><span className="material-symbols-outlined">download</span> Export</button>
                        <button onClick={handleReset} disabled={!originalImageSrc}><span className="material-symbols-outlined">restart_alt</span> Reset All</button>
                    </div>
                )}
            </div>
        </div>
      </header>
      <main className="main-content">
        <aside className="toolbar">
            <AccordionSection title="Presets" id="presets" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <div className="tool-subsection">
                    <h4>Built-in</h4>
                    <div className="preset-group">
                        <button className="btn-preset" onClick={() => applyBuiltInPreset('vintage')} disabled={!originalImageSrc}>Vintage</button>
                        <button className="btn-preset" onClick={() => applyBuiltInPreset('cinematic')} disabled={!originalImageSrc}>Cinematic</button>
                    </div>
                </div>
                <div className="tool-subsection">
                    <h4>My Presets</h4>
                    <div className="custom-presets-list">
                       {customPresets.length === 0 && <p className="no-presets">No saved presets yet.</p>}
                       {customPresets.map((p, i) => (
                           <div key={i} className="custom-preset-item">
                               <span onClick={() => loadCustomPreset(p)}>{p.name}</span>
                               <button onClick={() => deleteCustomPreset(i)} className="delete-preset-btn"><span className="material-symbols-outlined">delete</span></button>
                           </div>
                       ))}
                    </div>
                    <button className="btn btn-secondary" onClick={saveCustomPreset} disabled={!originalImageSrc}><span className="material-symbols-outlined">add</span> Save Current Settings</button>
                </div>
            </AccordionSection>

            <AccordionSection title="Basic Adjustments" id="basic" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <div className="slider-grid">
                    {Object.entries(displayState.filters).filter(([key]) => ['brightness', 'contrast', 'saturate', 'sepia', 'exposure', 'highlights', 'shadows', 'temperature'].includes(key)).map(([key, value]) => {
                        const min = (key === 'brightness' || key === 'contrast' || key === 'saturate') ? 0 : (key === 'sepia' ? 0 : -100);
                        const max = (key === 'brightness' || key === 'contrast' || key === 'saturate') ? 200 : 100;
                        const label = key.charAt(0).toUpperCase() + key.slice(1);
                        return (
                            <WavySlider 
                                key={key}
                                label={label}
                                unit={['brightness', 'contrast', 'saturate', 'sepia'].includes(key) ? '%' : ''}
                                value={value}
                                min={min}
                                max={max}
                                onChange={(e) => handleFilterLiveChange(key as keyof BasicFilters, e.target.value)}
                                onCommit={handleCommit}
                                onInteractionStart={handleInteractionStart}
                                disabled={!originalImageSrc}
                            />
                        )
                    })}
                </div>
            </AccordionSection>
            
            <AccordionSection title="Color" id="color" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <div className="tool-subsection">
                    <h4>HSL Adjustments</h4>
                    {Object.entries(displayState.hsl).map(([colorName, colorValue]) => (
                        <div key={colorName} className="hsl-color-section">
                            <p style={{color: colorName}}>{colorName.charAt(0).toUpperCase() + colorName.slice(1)}</p>
                            <WavySlider label="Hue" unit="" value={colorValue.h} min={-100} max={100} 
                                onChange={(e) => handleHslLiveChange(colorName as keyof HSLFilters, 'h', e.target.value)} 
                                onCommit={handleCommit}
                                onInteractionStart={handleInteractionStart}
                                disabled={!originalImageSrc} />
                            <WavySlider label="Saturation" unit="" value={colorValue.s} min={-100} max={100} 
                                onChange={(e) => handleHslLiveChange(colorName as keyof HSLFilters, 's', e.target.value)} 
                                onCommit={handleCommit}
                                onInteractionStart={handleInteractionStart}
                                disabled={!originalImageSrc} />
                            <WavySlider label="Luminance" unit="" value={colorValue.l} min={-100} max={100} 
                                onChange={(e) => handleHslLiveChange(colorName as keyof HSLFilters, 'l', e.target.value)} 
                                onCommit={handleCommit}
                                onInteractionStart={handleInteractionStart}
                                disabled={!originalImageSrc} />
                        </div>
                    ))}
                </div>
            </AccordionSection>

            <AccordionSection title="Masking" id="masking" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <p className="tool-note">Create a mask, then use an AI Tool to affect only the masked area.</p>
                <div className="button-group">
                    <button className="btn btn-secondary" onClick={() => aiMasking("Create a black and white mask of the main subject. The subject must be perfectly white and the background black.", "Masking Subject...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">person</span> Mask Subject</button>
                    <button className="btn btn-secondary" onClick={() => aiMasking("Create a black and white mask of the sky. The sky must be perfectly white and everything else black.", "Masking Sky...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">cloud</span> Mask Sky</button>
                    <button className="btn btn-secondary" onClick={() => generateGradientMask('linear')} disabled={!originalImageSrc}><span className="material-symbols-outlined">vertical_align_center</span> Linear Gradient</button>
                    <button className="btn btn-secondary" onClick={() => generateGradientMask('radial')} disabled={!originalImageSrc}><span className="material-symbols-outlined">filter_tilt_shift</span> Radial Gradient</button>
                </div>
                 <div className="tool-subsection">
                    <h4>Brush Mask</h4>
                     <div className="brush-controls">
                        <button onClick={() => setIsBrushActive(!isBrushActive)} className={`btn-tool ${isBrushActive ? 'active' : ''}`} title="Brush Tool" disabled={!originalImageSrc}><span className="material-symbols-outlined">brush</span></button>
                        <button onClick={() => setIsErasing(!isErasing)} className={`btn-tool ${isErasing ? 'active' : ''}`} title="Eraser" disabled={!isBrushActive}><span className="material-symbols-outlined">ink_eraser</span></button>
                        <WavySlider label="Size" unit="" value={brushSize} min={1} max={100} onChange={e => setBrushSize(parseInt(e.target.value))} onCommit={()=>{}} onInteractionStart={()=>{}} disabled={!isBrushActive}/>
                     </div>
                </div>
                {currentState.maskSrc && (
                    <div className="tool-subsection">
                        <div className="toggle-switch">
                        <label htmlFor="invert-mask">Invert Mask</label>
                        <label className="switch"><input id="invert-mask" type="checkbox" checked={currentState.isMaskInverted} onChange={(e) => commitChange(p => ({...p, isMaskInverted: e.target.checked}))} /><span className="switch-slider"></span></label>
                        </div>
                        <button className="btn btn-secondary" onClick={() => commitChange(p => ({...p, maskSrc: null}))}><span className="material-symbols-outlined">layers_clear</span> Clear Mask</button>
                    </div>
                )}
            </AccordionSection>

            <AccordionSection title="AI Tools" id="ai-tools" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <div className="button-group">
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Subtly enhance the overall quality of this image, improving lighting, colors, and clarity for a natural, professional look.", "AI Enhancing...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">auto_awesome</span> AI Enhance</button>
                    <button className="btn btn-secondary" onClick={handleRemoveSubject} disabled={!originalImageSrc || isLoading || !currentState.maskSrc}><span className="material-symbols-outlined">person_remove</span> Remove Subject</button>
                    <button className="btn btn-secondary" onClick={() => setShowGenFillModal(true)} disabled={!originalImageSrc || isLoading || !currentState.maskSrc}><span className="material-symbols-outlined">auto_fix_high</span> Generative Fill</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Dramatically enhance the sky in this image, making the colors more vibrant and adding definition to the clouds.", "Enhancing Sky...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">wb_cloudy</span> Sky Enhance</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Perform professional-grade skin smoothening and blemish removal. Focus on a natural look, retaining skin texture.", "Retouching Skin...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">face_retouching_natural</span> Retouch Skin</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Perform AI-based denoising on this image, removing noise while preserving details.", "AI Denoising...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">grain</span> AI Denoise</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Upscale this image to a higher resolution using AI. Add detail and sharpness where appropriate.", "AI Upscaling...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">zoom_in_map</span> AI Upscale</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Correct for lens distortion and chromatic aberration in this image. Return only the final image.", "Fixing Lens...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">center_focus_strong</span> Lens Correction</button>
                    <button className="btn btn-secondary" onClick={() => aiImageToImage("Expand the canvas of this image by 20% on all sides, filling in the new areas with content that logically and realistically extends the original scene.", "Generative Expanding...")} disabled={!originalImageSrc || isLoading}><span className="material-symbols-outlined">aspect_ratio</span> Generative Expand</button>
                    <div className="dropdown-group">
                        <select onChange={e => aiImageToImage(e.target.value, "Applying Refocus...")} disabled={!originalImageSrc || isLoading} value="">
                            <option value="" disabled>AI Refocus...</option>
                            <option value="Refocus the image on the main subject, applying a realistic, subtle bokeh effect to the background.">Subtle Bokeh</option>
                            <option value="Refocus the image on the main subject, applying a standard, creamy bokeh effect to the background.">Standard Bokeh</option>
                            <option value="Refocus the image on the main subject, applying a strong, artistic bokeh effect with circular highlights to the background.">Artistic Bokeh</option>
                        </select>
                        <span className="material-symbols-outlined">camera</span>
                    </div>
                </div>
            </AccordionSection>

            <AccordionSection title="Effects" id="effects" activeAccordion={activeAccordion} setActiveAccordion={setActiveAccordion}>
                <div className="slider-grid">
                    {Object.entries(displayState.filters).filter(([key]) => ['sharpen', 'dehaze', 'grain'].includes(key)).map(([key, value]) => {
                        const label = key.charAt(0).toUpperCase() + key.slice(1);
                        return (
                           <WavySlider 
                                key={key}
                                label={label}
                                unit=""
                                value={value}
                                min={0}
                                max={100}
                                onChange={(e) => handleFilterLiveChange(key as keyof BasicFilters, e.target.value)}
                                onCommit={handleCommit}
                                onInteractionStart={handleInteractionStart}
                                disabled={!originalImageSrc}
                           />
                        )
                    })}
                </div>
            </AccordionSection>
        </aside>
        
        <div className="canvas-area">
          <input type="file" ref={fileInputRef} onChange={handleImageUpload} accept="image/*" style={{ display: 'none' }} />
          {originalImageSrc ? (
            <>
            <div className={`canvas-container ${isSideBySide ? 'side-by-side' : ''}`} 
                 onWheel={handleWheel} 
                 onDoubleClick={handleDoubleClick}
            >
              {(isSideBySide) && (
                  <div className="side-by-side-pane">
                      <img src={originalImageSrc} alt="Original" />
                      <span className="view-label">Before</span>
                  </div>
              )}
              <div ref={canvasWrapperRef} 
                   className={`canvas-wrapper ${isPeeking ? 'peeking' : ''} ${isBrushActive ? 'brush-active' : ''}`}
                   onMouseDown={handleCanvasWrapperMouseDown}
                   onMouseMove={handleCanvasWrapperMouseMove}
                   onMouseUp={handleCanvasWrapperMouseUp}
                   onMouseLeave={handleCanvasWrapperMouseUp}
              >
                  <img className="peek-image" src={originalImageSrc} alt="Original" />
                  
                  {preview.active && preview.src && (
                    <img 
                        src={preview.src} 
                        className="preview-image-active"
                        alt="Editing preview"
                        style={{
                            width: preview.width,
                            height: preview.height,
                            transform: `scale(${transform.zoom}) translate(${transform.pan.x}px, ${transform.pan.y}px)`,
                            filter: liveFilterStyle,
                        }}
                    />
                  )}

                  <canvas 
                    ref={canvasRef} 
                    style={{ 
                        transform: `scale(${transform.zoom}) translate(${transform.pan.x}px, ${transform.pan.y}px)`, 
                        filter: mainFilterStyle, 
                        pointerEvents: isBrushActive ? 'none' : 'auto',
                        visibility: preview.active ? 'hidden' : 'visible'
                    }}
                  ></canvas>

                  <canvas ref={maskCanvasRef} style={{ transform: `scale(${transform.zoom}) translate(${transform.pan.x}px, ${transform.pan.y}px)`, opacity: 0.5, position: 'absolute', top: 0, left: 0, pointerEvents: isBrushActive ? 'auto' : 'none' }}></canvas>
                  {isSideBySide && <span className="view-label">After</span>}
              </div>
            </div>
            <div className="view-controls">
                <button onClick={undo} disabled={!canUndo} title="Undo" className="view-btn-round"><span className="material-symbols-outlined">undo</span></button>
                <button onClick={redo} disabled={!canRedo} title="Redo" className="view-btn-round"><span className="material-symbols-outlined">redo</span></button>
                <div className="divider"></div>
                <div className="zoom-control-integrated" title="Zoom">
                    <span className="material-symbols-outlined">zoom_out</span>
                    <input 
                      type="range" 
                      min="0.2" max="5" step="0.1" 
                      value={transform.zoom} 
                      onChange={e => setTransform(t => ({...t, zoom: parseFloat(e.target.value)}))} 
                      className="view-zoom-slider"
                      aria-label="Zoom slider"
                      disabled={!originalImageSrc}
                    />
                    <span className="material-symbols-outlined">zoom_in</span>
                </div>
                <div className="divider"></div>
                 <button 
                    onPointerDown={handleBeforeAfterPointerDown} 
                    onPointerUp={handleBeforeAfterPointerUp} 
                    onPointerLeave={handleBeforeAfterPointerUp}
                    className={`view-btn-pill ${isSideBySide ? 'active' : ''}`} 
                    title="Click for side-by-side. Hold to peek."
                    disabled={!originalImageSrc}>
                    <span className="material-symbols-outlined">compare</span>Before/After
                </button>
            </div>
            </>
          ) : (
            <div className="placeholder" onClick={() => fileInputRef.current?.click()}>
              <span className="material-symbols-outlined">image</span>
              <p>Upload an image to start editing</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
root.render(<App />);