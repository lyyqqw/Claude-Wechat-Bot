/**
 * 管理面板 —— JWT 鉴权中间件
 *
 * 在 .env 中配置:
 *   PANEL_USERNAME=admin
 *   PANEL_PASSWORD=your-password
 *   PANEL_SECRET=random-secret-key
 *   PANEL_PORT=3000
 */
import jwt from 'jsonwebtoken';

const USERNAME = process.env.PANEL_USERNAME || 'admin';
const PASSWORD = process.env.PANEL_PASSWORD || 'admin';
const SECRET = process.env.PANEL_SECRET || 'claude-wechat-panel-secret';

/**
 * POST /api/login — 获取 JWT token
 */
export function loginHandler(req, res) {
  const { username, password } = req.body || {};
  if (username !== USERNAME || password !== PASSWORD) {
    return res.status(401).json({ error: '用户名或密码错误' });
  }

  const token = jwt.sign(
    { username, role: 'admin', iat: Math.floor(Date.now() / 1000) },
    SECRET,
    { expiresIn: '24h' },
  );

  res.json({ token });
}

/**
 * 验证 JWT 的中间件
 */
export function authMiddleware(req, res, next) {
  // 只保护 /api/ 路径，前端静态文件不验证
  if (!req.path.startsWith('/api/')) return next();
  // 登录接口不验证
  if (req.path === '/api/login') return next();

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未登录' });
  }

  try {
    const token = authHeader.slice(7);
    req.user = jwt.verify(token, SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Token 已过期或无效' });
  }
}
