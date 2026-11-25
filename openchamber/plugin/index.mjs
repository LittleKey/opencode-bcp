import plugin from "./file-archive.js";
import { loadOperatorOptions } from "./operator-options.mjs";

export default {
  id: plugin.id,
  async setup(ctx) {
    await plugin.setup({ ...ctx, options: { loadOperatorOptions } });
  },
};
