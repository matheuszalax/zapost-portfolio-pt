# 04 — Motor Gráfico no Navegador & Exportação Vetorial

## Arquitetura do Canvas sem Bibliotecas Externas

O zapost implementa um editor visual de alta fidelidade montado diretamente sobre o DOM do navegador e manipulação de estilos nativos, sem depender de motores legados pesados (como Fabric.js ou Konva.js), reduzindo drasticamente o tamanho do bundle JavaScript.

```
┌────────────────────────────────────────────────────────────────────────┐
│                      Área do Canvas (3:4 / 9:16)                       │
│                                                                        │
│   ┌────────────────────────────────────────────────────────────────┐   │
│   │ 1. Camada de Imagem de Fundo (Posição X/Y, Zoom, Enquadramento)│   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 2. Máscara de Cor / Gradiente (Tom Hexadecimal, Opacidade)     │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 3. Camada de Cabeçalho (Avatar, Identificador @, Selo Verificado│   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 4. Bloco de Tipografia (Título, Marcador Accent, Subtítulo)    │   │
│   ├────────────────────────────────────────────────────────────────┤   │
│   │ 5. Camada de Rodapé & Indicador de Slide (Paginação)           │   │
│   └────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Gestão de Estado e Desacoplamento em Hooks

Em vez de bibliotecas globais de estado (Redux, Zustand), o editor opera com hooks locais especializados e de responsabilidade única:

| Hook | Responsabilidade Única | Garantias & Comportamentos |
|---|---|---|
| `useCanvasState` | Estado do canvas (cores, fontes, textos, overlays) | Memos derivados para cores seguras, fontes ativas e contagem de caracteres |
| `useCanvasZoom` | Escala, cálculos de ResizeObserver e scroll centralizado | Limita o zoom entre $0.4\times$ e $2.4\times$ |
| `useCanvasHistory` | Pilha de histórico de Undo/Redo | Buffer circular limitado a 30 snapshots |
| `useAutosave` | Persistência automática em background via `PATCH /api/posts/[id]` | Debounce de 2000ms com verificação de alterações ativas |
| `usePopoverManager` | Unifica captura de eventos de clique fora (pointerdown) | Fecha barras e menus flutuantes sem conflitos entre listeners |

---

## 2. Design System Neutro (Tailwind CSS v4)

A interface do editor utiliza **Tailwind CSS v4** com variáveis CSS nativas:
* **Paleta Escura Neutra:** Baseada em tons neutros balanceados inspirados no Claude.ai: `#1f1f1e` (fundo principal), `#252524` (superfície/popovers), `#2e2e2d` (botões e controles) e `#ececea` (texto primário de alto contraste).
* **Prevenção de Flash de Tema (Zero FOUC):** O tema inicial (`claro`, `escuro` ou `sistema`) é gravado em cookie HTTP seguro, permitindo que os Server Components do Next.js injetem o atributo `data-theme` correto antes da hidratação do cliente.

---

## 3. Pipeline de Exportação Multi-Formato

Um dos grandes diferenciais de engenharia do zapost é a capacidade de gerar tanto arquivos rasterizados para redes sociais quanto vetoriais editáveis para designers gráficos:

### A. Rasterização de Alta Resolução (`html-to-image`)
* Exporta imagens PNG em 1x e 2x (alta densidade de pixels para telas Retina), JPEG 2x e WebP de alta eficiência.
* Imagens externas passam obrigatoriamente pelo `/api/image-proxy` para fornecer cabeçalhos CORS limpos, impedindo que o elemento `<canvas>` seja maculado (*canvas taint error*).

### B. Construtor Vetorial de SVG em Camadas (`src/lib/svg-export.ts`)
* Gera um documento XML SVG puro preservando camadas individuais, alinhamentos, marcadores visuais, textos e opacidades.
* O arquivo resultante pode ser aberto e editado diretamente no Adobe Illustrator ou Figma com tipografia vetorial intacta.

### C. Compilação de PDF Vetorial com Fontes Embutidas (`pdf-lib` + `@pdf-lib/fontkit`)
* **Lazy Loading:** O pacote `pdf-lib` é carregado dinamicamente via `await import(...)` apenas no momento em que o usuário clica para exportar em PDF, mantendo a carga inicial do editor rápida.
* **Injeção de Tipografia Customizada:** Faz a leitura binária das fontes `.ttf` e `.otf` em tempo de execução e as incorpora no PDF usando `@pdf-lib/fontkit`, garantindo fidelidade tipográfica em qualquer leitor de PDF móvel ou desktop.

### D. Empacotamento em Lote com ZIP em Memória (`jszip`)
* Em carrosséis com até 15 slides, cada página é renderizada assincronamente e reunida em um arquivo `.zip` diretamente na memória do navegador via `jszip`, iniciando o download sem consumir banda ou armazenamento do servidor.
