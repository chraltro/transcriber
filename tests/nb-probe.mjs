// Why does NB-Whisper tiny use more memory than stock tiny in WebKit? Compare what each repo
// ships: file sizes of the weights the CPU path loads, and the generation settings.
const hf = async (path) => (await fetch(`https://huggingface.co/${path}`)).json();
for (const id of ['onnx-community/whisper-tiny', 'Xenova/nb-whisper-tiny-beta', 'onnx-community/whisper-base', 'onnx-community/nb-whisper-base-ONNX', 'NbAiLab/nb-whisper-tiny']) {
  console.log(`\n=== ${id}`);
  const tree = await hf(`api/models/${id}/tree/main/onnx`);
  for (const f of Array.isArray(tree) ? tree : []) if (/(encoder_model|decoder_model_merged|decoder_model)(_quantized|_q4|_fp16)?\.onnx$/.test(f.path)) console.log(`  ${f.path.padEnd(45)} ${(f.size / 1e6).toFixed(1)} MB`);
  for (const file of ['generation_config.json', 'config.json']) {
    try {
      const j = await hf(`${id}/resolve/main/${file}`);
      const keep = file === 'config.json'
        ? ['d_model', 'encoder_layers', 'decoder_layers', 'vocab_size', 'max_target_positions', 'torch_dtype']
        : ['num_beams', 'max_length', 'no_repeat_ngram_size', 'return_timestamps', 'do_sample', 'length_penalty'];
      console.log(`  ${file}: ${JSON.stringify(Object.fromEntries(keep.filter((k) => k in j).map((k) => [k, j[k]])))}`);
    } catch (e) { console.log(`  ${file}: ${e.message}`); }
  }
}
