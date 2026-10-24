"use client";

import { use } from "react";
import dynamic from "next/dynamic";

const Builder = dynamic(() => import("./builder"), {
  ssr: false,
  loading: () => (
    <div className="flex h-screen items-center justify-center text-sm text-[var(--fp-text-2)]">
      Loading workflow builder…
    </div>
  ),
});

export default function BuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <Builder workflowId={id} />;
}
