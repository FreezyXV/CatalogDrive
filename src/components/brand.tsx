import { Layers3 } from "lucide-react";
export function Brand({ light = false }: { light?: boolean }) {
  return (
    <span className={`brand ${light ? "brand-light" : ""}`}>
      <span className="brand-symbol">
        <Layers3 size={23} strokeWidth={1.8} />
      </span>
      CataMotive<span className="brand-dot">.</span>
    </span>
  );
}
