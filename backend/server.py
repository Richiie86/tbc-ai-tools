"""TBC AI Tools — FastAPI backend server.

Main application entry point that wires together all the extension modules.
Each `*_ext.py` file exports a router that gets mounted here under `/api`.
"""
import asyncio
import logging
import os
import signal
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import uvicorn
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

# Load environment variables from .env file if it exists
load_dotenv(Path(__file__).parent / '.env')

# Configure logging before any imports that might log
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger('tbc')

# Import the database connection after env vars are loaded
from db import db, client

# Default model for new chat sessions. This is the "max quality" tier in amAI
# — when the operator hasn't changed the dial, behaviour is unchanged.
DEFAULT_MODEL = 'claude-sonnet-4-5-20250929'

# Model provider mapping for resolve_model() and the LLM router
MODEL_PROVIDERS = {
    # Anthropic models
    'claude-sonnet-4-5-20250929': 'anthropic',
    'claude-haiku-4-5-20251001': 'anthropic',
    'claude-opus-4-5-20251001': 'anthropic',
    'claude-3-5-sonnet-20241022': 'anthropic',
    'claude-3-5-haiku-20241022': 'anthropic',
    'claude-3-opus-20240229': 'anthropic',
    'claude-3-sonnet-20240229': 'anthropic',
    'claude-3-haiku-20240307': 'anthropic',
    
    # OpenAI models
    'gpt-4.1': 'openai',
    'gpt-4o': 'openai',
    'gpt-4o-mini': 'openai',
    'gpt-4-turbo': 'openai',
    'gpt-4': 'openai',
    'gpt-3.5-turbo': 'openai',
    'o1-preview': 'openai',
    'o1-mini': 'openai',
    'o3-mini': 'openai',
    
    # Google/Gemini models
    'gemini-2.5-pro': 'gemini',
    'gemini-2.5-flash': 'gemini',
    'gemini-pro': 'gemini',
    'gemini-pro-vision': 'gemini',
    'gemini-flash': 'gemini',
    
    # OpenRouter models (proxy service)
    'anthropic/claude-sonnet-4': 'openrouter',
    'anthropic/claude-3-5-sonnet': 'openrouter',
    'openai/gpt-4o-mini': 'openrouter',
    'google/gemini-2.5-flash': 'openrouter',
    'meta-llama/llama-3.3-70b-instruct': 'openrouter',
    'qwen/qwen-2.5-72b-instruct': 'openrouter',
    'mistralai/mistral-large': 'openrouter',
    'deepseek/deepseek-chat': 'openrouter',
    
    # Groq models
    'llama-3.3-70b-versatile': 'groq',
    'llama-3.1-70b-versatile': 'groq',
    'mixtral-8x7b-32768': 'groq',
}

# APScheduler instance for background tasks
scheduler = AsyncIOScheduler()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan manager — startup and shutdown hooks."""
    # Startup
    logger.info('TBC AI Tools backend starting up...')
    
    # Start the CORS refresher background task
    from cors_dynamic_ext import start_cors_refresher
    try:
        await start_cors_refresher()
        logger.info('CORS dynamic origin refresher started')
    except Exception as e:
        logger.error(f'Failed to start CORS refresher: {e}')
    
    # Start background schedulers
    try:
        # Birthday rewards (daily)
        from birthday_ext import birthday_scheduler_loop
        asyncio.create_task(birthday_scheduler_loop())
        
        # Analytics alerts (hourly checks, daily work)
        from alerts_ext import alerts_scheduler_loop
        asyncio.create_task(alerts_scheduler_loop())
        
        # APScheduler for cron jobs
        scheduler.start()
        
        # Auto-fix loop (every 5 minutes)
        from auto_fix_loop_ext import run_auto_fix_tick
        scheduler.add_job(
            run_auto_fix_tick,
            'interval',
            minutes=5,
            id='auto_fix_loop',
            max_instances=1,
        )
        
        # Auto-withdraw (hourly)
        from autowithdraw_ext import run_auto_withdraw_once
        scheduler.add_job(
            run_auto_withdraw_once,
            'interval',
            hours=1,
            id='auto_withdraw',
            max_instances=1,
        )
        
        # BYOK billing (daily at 02:00 UTC)
        from byok_ext import run_byok_billing_pass
        scheduler.add_job(
            run_byok_billing_pass,
            'cron',
            hour=2,
            minute=0,
            id='byok_billing',
            max_instances=1,
        )
        
        # AI Test Bench drift alerts (daily at 03:00 UTC)
        from ai_test_bench_ext import _nightly_drift_alert
        scheduler.add_job(
            _nightly_drift_alert,
            'cron',
            hour=3,
            minute=0,
            id='ai_test_bench_drift',
            max_instances=1,
        )
        
        # Auto-learning garbage collection (daily at 04:00 UTC)
        from ai_learnings_ext import archive_stale_proposals
        scheduler.add_job(
            archive_stale_proposals,
            'cron',
            hour=4,
            minute=0,
            id='ai_learnings_gc',
            max_instances=1,
        )
        
        logger.info('Background schedulers started')
    except Exception as e:
        logger.error(f'Failed to start background schedulers: {e}')
    
    # Bootstrap operator account
    try:
        await bootstrap_operator()
    except Exception as e:
        logger.error(f'Operator bootstrap failed: {e}')
    
    yield
    
    # Shutdown
    logger.info('TBC AI Tools backend shutting down...')
    try:
        scheduler.shutdown(wait=False)
        await client.close()
        logger.info('Cleanup completed')
    except Exception as e:
        logger.error(f'Shutdown cleanup failed: {e}')


async def bootstrap_operator():
    """Create the initial operator account if none exists."""
    try:
        existing = await db.users.find_one({'role': 'operator'})
        if existing:
            return
        
        email = os.environ.get('OPERATOR_EMAIL')
        password = os.environ.get('OPERATOR_PASSWORD')
        
        if not email or not password:
            logger.warning('OPERATOR_EMAIL or OPERATOR_PASSWORD not set — no bootstrap operator created')
            return
        
        # Import here to avoid circular dependencies
        import bcrypt
        import uuid
        
        hashed = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
        
        user_doc = {
            'id': str(uuid.uuid4()),
            'email': email,
            'name': 'Operator',
            'password_hash': hashed.decode('utf-8'),
            'role': 'operator',
            'credits': float('inf'),
            'email_verified': True,
            'created_at': datetime.now(timezone.utc),
            'last_login_at': None,
        }
        
        await db.users.insert_one(user_doc)
        logger.info(f'Bootstrap operator account created: {email}')
        
    except Exception as e:
        logger.error(f'Failed to bootstrap operator: {e}')


app = FastAPI(
    title='TBC AI Tools API',
    description='AI-assisted build & deploy operator platform',
    version='1.0.0',
    lifespan=lifespan,
)

# CORS configuration
from cors_dynamic_ext import DynamicOriginCORSMiddleware

# Build CORS origins from environment and config
cors_origins = []
env_origins = os.environ.get('CORS_ORIGINS', '').strip()
if env_origins and env_origins != '*':
    cors_origins.extend([o.strip() for o in env_origins.split(',') if o.strip()])

# Always allow the platform domains
cors_origins.extend([
    'https://tbctools.org',
    'https://www.tbctools.org',
    'http://localhost:3000',  # Local development
    'http://localhost:3001',  # Alternative dev port
])

# Add PRIMARY_DOMAIN if configured
primary_domain = os.environ.get('PRIMARY_DOMAIN', '').strip()
if primary_domain:
    cors_origins.append(f'https://{primary_domain}')
    cors_origins.append(f'https://www.{primary_domain}')

# Remove duplicates while preserving order
seen = set()
cors_origins_clean = []
for origin in cors_origins:
    if origin not in seen:
        seen.add(origin)
        cors_origins_clean.append(origin)

# Use our dynamic CORS middleware that also checks deployed project domains
app.add_middleware(
    DynamicOriginCORSMiddleware,
    allow_origins=cors_origins_clean if env_origins != '*' else ['*'],
    allow_credentials=True,
    allow_methods=['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allow_headers=['*'],
)

# Global exception handler
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    logger.error(f'Unhandled exception: {exc}', exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={'detail': 'Internal server error'}
    )

# Health check endpoint
@app.get('/healthcheck')
async def health_check():
    """Basic health check endpoint."""
    try:
        # Test database connection
        await db.users.count_documents({}, limit=1)
        return {
            'status': 'healthy',
            'timestamp': datetime.now(timezone.utc).isoformat(),
            'service': 'tbc-ai-tools-backend'
        }
    except Exception as e:
        logger.error(f'Health check failed: {e}')
        raise HTTPException(status_code=503, detail='Service unhealthy')

# Root endpoint
@app.get('/')
async def root():
    return {
        'message': 'TBC AI Tools API',
        'version': '1.0.0',
        'status': 'running'
    }

# Helper function to resolve model to provider
async def resolve_model(model_id: str = None) -> tuple[str, str]:
    """Resolve a model ID to its provider. Returns (provider, model_id).
    
    Falls back to the operator's configured default model when model_id is None,
    'auto', or unrecognized. The amAI module can override the default via the
    quality dial.
    """
    if not model_id or model_id == 'auto':
        # Import here to avoid circular dependency
        try:
            from amai_ext import get_default_model, is_auto_default, pick_auto_model
            
            # Check if auto mode is the operator-wide default
            if await is_auto_default():
                model_id = 'auto'
            else:
                model_id = await get_default_model()
        except Exception as e:
            logger.warning(f'Failed to get default model: {e}')
            model_id = DEFAULT_MODEL
    
    # Handle auto model selection
    if model_id == 'auto':
        # This should be handled by the caller with the actual message content
        # For now, return the best model
        return 'anthropic', 'claude-sonnet-4-5-20250929'
    
    provider = MODEL_PROVIDERS.get(model_id)
    if not provider:
        # Unknown model, fall back to default
        logger.warning(f'Unknown model {model_id}, falling back to {DEFAULT_MODEL}')
        model_id = DEFAULT_MODEL
        provider = MODEL_PROVIDERS.get(model_id, 'anthropic')
    
    return provider, model_id

# Import and mount all extension routers
def setup_routers():
    """Import and mount all the extension module routers."""
    
    # Auth and user management
    from auth_ext import router as auth_router
    app.include_router(auth_router, prefix='/api')
    
    from users_ext import router as users_router
    app.include_router(users_router, prefix='/api')
    
    # Chat system
    from chat_ext import router as chat_router
    app.include_router(chat_router, prefix='/api')
    
    from chat_deploy_ext import router as chat_deploy_router
    app.include_router(chat_deploy_router, prefix='/api')
    
    # AI and LLM
    from ai_learnings_ext import router as ai_learnings_router
    app.include_router(ai_learnings_router, prefix='/api')
    
    from ai_brain_ext import router as ai_brain_router
    app.include_router(ai_brain_router, prefix='/api')
    
    from ai_build_ext import router as ai_build_router
    app.include_router(ai_build_router, prefix='/api')
    
    from ai_build_tests_ext import router as ai_build_tests_router
    app.include_router(ai_build_tests_router, prefix='/api')
    
    from ai_test_bench_ext import router as ai_test_bench_router
    app.include_router(ai_test_bench_router, prefix='/api')
    
    from ai_visual_verify_ext import router as ai_visual_verify_router
    app.include_router(ai_visual_verify_router, prefix='/api')
    
    from amai_ext import router as amai_router
    app.include_router(amai_router, prefix='/api')
    
    # Sandbox and code execution
    from sandbox_ai_ext import router as sandbox_router
    app.include_router(sandbox_router, prefix='/api')
    
    # Deploy and operations
    from deploy_projects_ext import setup_routers as setup_deploy_routers
    setup_deploy_routers(app)
    
    from deploy_initial_push_ext import router as deploy_initial_push_router
    app.include_router(deploy_initial_push_router, prefix='/api')
    
    from vercel_api_ext import router as vercel_router
    app.include_router(vercel_router, prefix='/api')
    
    # Payments and billing
    from payments_ext import router as payments_router
    app.include_router(payments_router, prefix='/api')
    
    from billing_portal_ext import router as billing_portal_router
    app.include_router(billing_portal_router, prefix='/api')
    
    from byok_ext import router as byok_router
    app.include_router(byok_router, prefix='/api')
    
    # Extensions and integrations
    from porkbun_ext import router as porkbun_router
    app.include_router(porkbun_router, prefix='/api')
    
    from storage_config_ext import router as storage_router
    app.include_router(storage_router, prefix='/api')
    
    from webhook_ext import router as webhook_router
    app.include_router(webhook_router, prefix='/api')
    
    from context7_ext import router as context7_router
    app.include_router(context7_router, prefix='/api')
    
    # Analytics and monitoring
    from analytics_ext import router as analytics_router
    app.include_router(analytics_router, prefix='/api')
    
    from alerts_ext import router as alerts_router
    app.include_router(alerts_router, prefix='/api')
    
    from runtime_errors_ext import router as runtime_errors_router
    app.include_router(runtime_errors_router, prefix='/api')
    
    # Notifications and communication
    from notifications_ext import router as notifications_router
    app.include_router(notifications_router, prefix='/api')
    
    from birthday_ext import router as birthday_router
    app.include_router(birthday_router, prefix='/api')
    
    # App features
    from app_builder_ext import operator_router as app_builder_op_router
    from app_builder_ext import agent_router as app_builder_agent_router
    app.include_router(app_builder_op_router, prefix='/api')
    app.include_router(app_builder_agent_router, prefix='/api')
    
    from app_settings_ext import public_router as app_settings_public_router
    from app_settings_ext import op_router as app_settings_op_router
    app.include_router(app_settings_public_router, prefix='/api')
    app.include_router(app_settings_op_router, prefix='/api')
    
    from auto_fix_loop_ext import router as auto_fix_loop_router
    app.include_router(auto_fix_loop_router, prefix='/api')
    
    from autowithdraw_ext import router as autowithdraw_router
    app.include_router(autowithdraw_router, prefix='/api')
    
    from audit_ext import router as audit_router
    app.include_router(audit_router, prefix='/api')
    
    from changelog_ext import router as changelog_router
    app.include_router(changelog_router, prefix='/api')
    
    from cors_dynamic_ext import router as cors_router
    app.include_router(cors_router, prefix='/api')

# Setup all routers
setup_routers()

# Graceful shutdown handler
def signal_handler(signum, frame):
    logger.info(f'Received signal {signum}, shutting down gracefully...')
    # The lifespan context manager will handle cleanup

signal.signal(signal.SIGTERM, signal_handler)
signal.signal(signal.SIGINT, signal_handler)

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 8000))
    uvicorn.run(
        'server:app',
        host='0.0.0.0',
        port=port,
        reload=False,  # Disable in production
        access_log=True,
        log_level='info'
    )
