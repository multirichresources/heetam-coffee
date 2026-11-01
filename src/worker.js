// Server Heetam Coffee. Fail statik (page, gambar) diservis terus oleh Cloudflare.
// Laluan /api/* akan digunakan untuk order, CHIP dan admin.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        db: Boolean(env.DB),
        chip_brand_id: Boolean(env.CHIP_BRAND_ID),
        chip_secret_key: Boolean(env.CHIP_SECRET_KEY),
        spx_user_id: Boolean(env.SPX_USER_ID),
        spx_secret_key: Boolean(env.SPX_SECRET_KEY)
      });
    }
    if (url.pathname.startsWith("/api/")) {
      return Response.json({ ok: false, error: "Not found" }, { status: 404 });
    }
    return env.ASSETS.fetch(request);
  }
};
